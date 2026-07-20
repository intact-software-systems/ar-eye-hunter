import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    requireConditionalWrite,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    createStateMutationOutboxRecord,
    hashStateMutationCommand,
    StateMutationOutboxRepository,
    type StateMutationOutboxRecord,
} from '../repositories/StateMutationOutboxRepository.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import {
    computeGroupPresenceSummary,
    type GroupPresenceSummaryComputed,
    type GroupPresenceSummaryRead,
    validateGroupPresenceSummary,
} from './group-state-mutations.ts';
import type { StateMutationEffectEnqueueResult } from './StateMutationOutboxWork.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';

export type GroupPresenceSummaryWorkOptions = Readonly<{
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    serviceId: string;
    /** Wake the same durable drainer for the topology-only follow-up. */
    wakeStateMutationOutbox?: () => void;
    timing?: RallarTimingSink;
}>;

type GroupPresenceSummaryPhase =
    'read' | 'compute' | 'validate' | 'write' | 'transaction';

export class GroupPresenceSummaryWork {
    private readonly now: () => number;

    constructor(private readonly options: GroupPresenceSummaryWorkOptions) {
        this.now = options.now ?? (() => Date.now());
    }

    async enqueueForGroupSnapshot(
        group: GroupSnapshot,
        deliveryId: string,
    ): Promise<StateMutationEffectEnqueueResult> {
        return await this.converge(group.group, deliveryId);
    }

    async converge(
        ref: GroupRef,
        deliveryId: string,
    ): Promise<StateMutationEffectEnqueueResult> {
        const command = {
            operation: 'convergeGroupPresenceSummary',
            aggregateRef: ref,
            deliveryId,
        } as const;
        const commandHash = await hashStateMutationCommand(command);
        let lastConflict: RuntimeStateWriteConflictError | undefined;
        for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
            const backoffStarted = performance.now();
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: this.options.sleep },
            );
            this.record('backoff', 'ok', performance.now() - backoffStarted, {
                deliveryId,
                attempt,
                backoffMs,
            }, ref);
            let activePhase: GroupPresenceSummaryPhase = 'read';
            let phaseStarted = performance.now();
            let phaseRecorded = false;
            let transactionStarted: number | undefined;
            try {
                const read = await readGroupPresenceSummary(
                    this.options.runtimeRepository,
                    ref,
                );
                this.recordPhase(
                    'read',
                    'ok',
                    phaseStarted,
                    ref,
                    deliveryId,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'compute';
                phaseStarted = performance.now();
                phaseRecorded = false;
                const computed = computeGroupPresenceSummary({
                    ref,
                    read,
                    nowEpochMs: this.now(),
                });
                this.recordPhase(
                    'compute',
                    'ok',
                    phaseStarted,
                    ref,
                    deliveryId,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'validate';
                phaseStarted = performance.now();
                phaseRecorded = false;
                validateGroupPresenceSummary({ ref, read, computed });
                if (computed.outcome === 'no-op') {
                    this.recordPhase(
                        'validate',
                        'ok',
                        phaseStarted,
                        ref,
                        deliveryId,
                        attempt,
                        backoffMs,
                    );
                    phaseRecorded = true;
                    return {
                        effectiveSnapshotRevision: toGroupSnapshotStateRevision(
                            computed.summary.causalRevision.groupRevision,
                            computed.summary.causalRevision.presenceRevision,
                        ),
                    };
                }
                const outbox = createGroupPresenceSummaryOutbox(
                    ref,
                    deliveryId,
                    commandHash,
                    read.group.value,
                    computed,
                );
                this.recordPhase(
                    'validate',
                    'ok',
                    phaseStarted,
                    ref,
                    deliveryId,
                    attempt,
                    backoffMs,
                );
                phaseRecorded = true;

                activePhase = 'write';
                phaseStarted = performance.now();
                phaseRecorded = false;
                transactionStarted = performance.now();
                const written = await writeGroupPresenceSummary(
                    this.options.runtimeRepository,
                    computed,
                    outbox,
                );
                phaseRecorded = true;
                void written;
                this.recordPhase(
                    'transaction',
                    'ok',
                    transactionStarted,
                    ref,
                    deliveryId,
                    attempt,
                    backoffMs,
                );
                this.recordPhase(
                    'write',
                    'ok',
                    phaseStarted,
                    ref,
                    deliveryId,
                    attempt,
                    backoffMs,
                );
                this.options.wakeStateMutationOutbox?.();
                return {
                    effectiveSnapshotRevision: toGroupSnapshotStateRevision(
                        computed.summary.causalRevision.groupRevision,
                        computed.summary.causalRevision.presenceRevision,
                    ),
                };
            } catch (error) {
                if (activePhase === 'write' && transactionStarted !== undefined) {
                    this.recordPhase(
                        'transaction',
                        'error',
                        transactionStarted,
                        ref,
                        deliveryId,
                        attempt,
                        backoffMs,
                        error,
                    );
                }
                if (!phaseRecorded) {
                    this.recordPhase(
                        activePhase,
                        'error',
                        phaseStarted,
                        ref,
                        deliveryId,
                        attempt,
                        backoffMs,
                        error,
                    );
                }
                if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
                lastConflict = error;
                this.record('conflict', 'ok', 0, {
                    deliveryId,
                    attempt,
                    backoffMs,
                }, ref);
            }
        }
        throw new RuntimeStateRetryExhaustedError(
            lastConflict ?? new RuntimeStateWriteConflictError(),
        );
    }

    private recordPhase(
        phase: GroupPresenceSummaryPhase,
        status: 'ok' | 'error',
        started: number,
        ref: GroupRef,
        deliveryId: string,
        attempt: number,
        backoffMs: number,
        error?: unknown,
    ): void {
        this.record(`mutation.${phase}`, status, performance.now() - started, {
            deliveryId,
            attempt,
            backoffMs,
        }, ref, error);
    }

    private record(
        operation: string,
        status: 'ok' | 'error',
        durationMs: number,
        details: Readonly<Record<string, string | number | boolean | undefined>>,
        ref: GroupRef,
        error?: unknown,
    ): void {
        recordRallarTiming(this.options.timing, {
            component: 'group-presence-summary-work',
            operation,
            serviceId: this.options.serviceId,
            ...ref,
            details,
        }, status, durationMs, error);
    }
}

async function readGroupPresenceSummary(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    ref: GroupRef,
): Promise<GroupPresenceSummaryRead> {
    const repository = new GroupStateRepository(runtime);
    const [group, members, admissions, presenceSessions, current] = await Promise.all([
        repository.findGroupEntry(ref),
        repository.listMemberEntries(ref),
        repository.listPresenceAdmissionEntries(ref),
        repository.listPresenceSessionEntries(ref),
        repository.findPresenceSummaryEntry(ref),
    ]);
    if (!group) throw new Error(`Group not found for presence summary: ${ref.groupId}`);
    return {
        group,
        members,
        admissions,
        presenceSessions,
        current: current ?? null,
    };
}

async function writeGroupPresenceSummary(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    computed: Extract<GroupPresenceSummaryComputed, { outcome: 'write' }>,
    outbox: StateMutationOutboxRecord,
): Promise<void> {
    await runtime.begin(async (transaction) => {
        const repository = new GroupStateRepository(transaction);

        // Summary ownership is the first and only aggregate guard.
        requireConditionalWrite(computed.operation === 'insert'
            ? await repository.insertPresenceSummary(computed.summary)
            : await repository.updatePresenceSummary(
                computed.summary,
                computed.expectedRevision!,
            ));

        await new StateMutationOutboxRepository(transaction)
            .insertForAuthoritativeWrite(outbox);
    });
}

function createGroupPresenceSummaryOutbox(
    ref: GroupRef,
    deliveryId: string,
    commandHash: string,
    group: GroupSnapshot['group'],
    computed: Extract<GroupPresenceSummaryComputed, { outcome: 'write' }>,
): StateMutationOutboxRecord {
    return createStateMutationOutboxRecord({
        kind: 'group',
        aggregateRef: ref,
        commandId: `group-presence-summary:${deliveryId}`,
        commandHash,
        createdAtEpochMs: computed.summary.computedAtEpochMs,
        acceptedCausalRevision: {
            kind: 'group',
            stateRevision: toGroupSnapshotStateRevision(
                computed.summary.causalRevision.groupRevision,
                computed.summary.causalRevision.presenceRevision,
            ),
            causalRevision: computed.summary.causalRevision,
            snapshotVersion: group.snapshotVersion,
            metadataVersion: group.metadataVersion,
            rosterVersion: group.rosterVersion,
            presenceVersion: computed.summary.causalRevision.presenceRevision,
        },
        effects: ['rtc-topology-recompute'],
        event: { kind: 'none' },
    });
}
