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
} from '../repositories/StateMutationOutboxRepository.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import {
    computeGroupPresenceSummary,
    type GroupPresenceSummaryComputed,
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
            const backoffMs = await waitForRuntimeStateWriteRetry(
                attempt as 0 | 1 | 2,
                { sleep: this.options.sleep },
            );
            const started = performance.now();
            const repository = new GroupStateRepository(this.options.runtimeRepository);
            const [group, members, admissions, presenceSessions, current] = await Promise.all([
                repository.findGroupEntry(ref),
                repository.listMemberEntries(ref),
                repository.listPresenceAdmissionEntries(ref),
                repository.listPresenceSessionEntries(ref),
                repository.findPresenceSummaryEntry(ref),
            ]);
            if (!group) throw new Error(`Group not found for presence summary: ${ref.groupId}`);
            const read = {
                group,
                members,
                admissions,
                presenceSessions,
                current: current ?? null,
            };
            const computed = computeGroupPresenceSummary({
                ref,
                read,
                nowEpochMs: this.now(),
            });
            validateGroupPresenceSummary({ ref, read, computed });
            this.record('plan', 'ok', performance.now() - started, {
                deliveryId,
                attempt,
                backoffMs,
                outcome: computed.outcome,
            }, ref);
            if (computed.outcome === 'no-op') {
                return {
                    effectiveSnapshotRevision: toGroupSnapshotStateRevision(
                        computed.summary.causalRevision.groupRevision,
                        computed.summary.causalRevision.presenceRevision,
                    ),
                };
            }
            try {
                await this.write(ref, deliveryId, commandHash, group.value, computed);
                this.options.wakeStateMutationOutbox?.();
                return {
                    effectiveSnapshotRevision: toGroupSnapshotStateRevision(
                        computed.summary.causalRevision.groupRevision,
                        computed.summary.causalRevision.presenceRevision,
                    ),
                };
            } catch (error) {
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

    private async write(
        ref: GroupRef,
        deliveryId: string,
        commandHash: string,
        group: GroupSnapshot['group'],
        computed: Extract<GroupPresenceSummaryComputed, { outcome: 'write' }>,
    ): Promise<void> {
        await this.options.runtimeRepository.begin(async (transaction) => {
            const repository = new GroupStateRepository(transaction);

            // Summary ownership is the first and only aggregate guard.
            requireConditionalWrite(computed.operation === 'insert'
                ? await repository.insertPresenceSummary(computed.summary)
                : await repository.updatePresenceSummary(
                    computed.summary,
                    computed.expectedRevision!,
                ));

            const commandId = `group-presence-summary:${deliveryId}`;
            await new StateMutationOutboxRepository(transaction).putOrLoad(
                createStateMutationOutboxRecord({
                    kind: 'group',
                    aggregateRef: ref,
                    commandId,
                    commandHash,
                    createdAtEpochMs: computed.summary.computedAtEpochMs,
                    acceptedCausalRevision: {
                        kind: 'group',
                        stateRevision: toGroupSnapshotStateRevision(
                            computed.summary.causalRevision.groupRevision,
                            computed.summary.causalRevision.presenceRevision,
                        ),
                        snapshotVersion: group.snapshotVersion,
                        metadataVersion: group.metadataVersion,
                        rosterVersion: group.rosterVersion,
                        presenceVersion:
                            computed.summary.causalRevision.presenceRevision,
                    },
                    effects: ['rtc-topology-recompute'],
                    event: { kind: 'none' },
                }),
            );
        });
    }

    private record(
        operation: string,
        status: 'ok' | 'error',
        durationMs: number,
        details: Readonly<Record<string, string | number | boolean | undefined>>,
        ref: GroupRef,
    ): void {
        recordRallarTiming(this.options.timing, {
            component: 'group-presence-summary-work',
            operation,
            serviceId: this.options.serviceId,
            ...ref,
            details,
        }, status, durationMs);
    }
}
