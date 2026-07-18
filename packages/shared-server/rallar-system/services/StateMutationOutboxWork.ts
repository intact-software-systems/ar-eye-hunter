import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
    StateMutationOutboxRecord,
    StoredStateMutationOutboxRecord,
} from '../repositories/StateMutationOutboxRepository.ts';
import { StateMutationOutboxRepository } from '../repositories/StateMutationOutboxRepository.ts';
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import type {
    RtcTopologyStateMutationPublisher,
} from './RtcTopologyOutboxWork.ts';

const DEFAULT_STATE_MUTATION_OUTBOX_PAGE_SIZE = 32;
const MAX_DELIVERY_CAS_CONFLICT_RETRIES = 3;
const STATE_MUTATION_OUTBOX_SENDER_ID = 'state-mutation-outbox';

export type StateMutationOutboxSnapshotObservation =
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'client'; snapshot: ClientSnapshot }>
    | Readonly<{ kind: 'group'; snapshot: GroupSnapshot }>;

export type StateMutationOutboxDeliveryRead = Readonly<{
    stored: StoredStateMutationOutboxRecord;
    snapshot: StateMutationOutboxSnapshotObservation;
}>;

export type StateMutationOutboxDeliveryPlan = Readonly<{
    stored: StoredStateMutationOutboxRecord;
    snapshot: ClientSnapshot | GroupSnapshot | null;
    deliveredSnapshotRevision: number;
}>;

export type StateMutationOutboxSnapshotReaders = Readonly<{
    readClientSnapshot(
        ref: Extract<StateMutationOutboxRecord, { kind: 'client' }>['aggregateRef'],
    ): Promise<ClientSnapshot | undefined>;
    readGroupSnapshot(
        ref: Extract<StateMutationOutboxRecord, { kind: 'group' }>['aggregateRef'],
    ): Promise<GroupSnapshot | undefined>;
}>;

export type StateMutationOutboxDrainResult = Readonly<{
    scanned: number;
    delivered: number;
    retryable: number;
}>;

export type StateMutationOutboxWorkLike = Readonly<{
    hasPending(): Promise<boolean>;
    drainPending(): Promise<StateMutationOutboxDrainResult>;
}>;

export type GroupPresenceSummaryWorkPublisher = Readonly<{
    enqueueForGroupSnapshot(
        group: GroupSnapshot,
        deliveryId: string,
    ): Promise<void | StateMutationEffectEnqueueResult>;
}>;

export type StateMutationEffectEnqueueResult = Readonly<{
    effectiveSnapshotRevision: number;
}>;

export type StateMutationOutboxWorkOptions =
    & StateMutationOutboxSnapshotReaders
    & Readonly<{
        repository: StateMutationOutboxRepository;
        stateSyncPublisher: StateSyncPublisher;
        groupPresenceSummaryPublisher?: GroupPresenceSummaryWorkPublisher;
        rtcTopologyPublisher?: RtcTopologyStateMutationPublisher;
        now?: () => number;
        senderId?: string;
        pageSize?: number;
    }>;

export class StateMutationOutboxWork implements StateMutationOutboxWorkLike {
    private readonly now: () => number;
    private readonly senderId: string;
    private readonly pageSize: number;

    constructor(private readonly options: StateMutationOutboxWorkOptions) {
        this.now = options.now ?? (() => Date.now());
        this.senderId = options.senderId ?? STATE_MUTATION_OUTBOX_SENDER_ID;
        this.pageSize = Math.max(
            1,
            Math.floor(options.pageSize ?? DEFAULT_STATE_MUTATION_OUTBOX_PAGE_SIZE),
        );
    }

    async hasPending(): Promise<boolean> {
        return (await this.options.repository.listPendingPage({ limit: 1 }))
            .records.length > 0;
    }

    async drainPending(): Promise<StateMutationOutboxDrainResult> {
        const processedOutboxIds = new Set<string>();
        let delivered = 0;
        let retryable = 0;
        let afterKey: string | undefined;

        while (true) {
            const page = await this.options.repository.listPendingPage({
                afterKey,
                limit: this.pageSize,
            });
            for (const stored of page.records) {
                if (processedOutboxIds.has(stored.record.outboxId)) {
                    continue;
                }
                processedOutboxIds.add(stored.record.outboxId);
                if (await this.deliver(stored, 0)) {
                    delivered += 1;
                } else {
                    retryable += 1;
                }
            }
            if (
                page.nextAfterKey === null ||
                page.nextAfterKey === afterKey
            ) {
                break;
            }
            afterKey = page.nextAfterKey;
        }

        return {
            scanned: processedOutboxIds.size,
            delivered,
            retryable,
        };
    }

    private async deliver(
        stored: StoredStateMutationOutboxRecord,
        conflictAttempt: number,
    ): Promise<boolean> {
        const attemptedAtEpochMs = this.now();
        try {
            const read = await readStateMutationOutboxDelivery(
                stored,
                this.options,
            );
            const plan = computeStateMutationOutboxDelivery(read);
            validateStateMutationOutboxDelivery(plan);
            const deliveredSnapshotRevision =
                await enqueueStateMutationOutboxDelivery(
                plan,
                this.options.stateSyncPublisher,
                this.options.groupPresenceSummaryPublisher,
                this.options.rtcTopologyPublisher,
                this.senderId,
            );
            const write = await writeStateMutationOutboxDelivery(
                this.options.repository,
                {
                    stored,
                    attemptedAtEpochMs,
                    outcome: {
                        status: 'delivered',
                        deliveredSnapshotRevision,
                    },
                },
            );
            if (write.status === 'delivered') {
                return true;
            }
            if (
                write.status === 'conflict' &&
                write.current &&
                conflictAttempt + 1 < MAX_DELIVERY_CAS_CONFLICT_RETRIES
            ) {
                return await this.deliver(write.current, conflictAttempt + 1);
            }
            return false;
        } catch (error) {
            const write = await writeStateMutationOutboxDelivery(
                this.options.repository,
                {
                    stored,
                    attemptedAtEpochMs,
                    outcome: {
                        status: 'retryable',
                        error: toErrorMessage(error),
                    },
                },
            );
            return write.status === 'delivered';
        }
    }
}

export async function readStateMutationOutboxDelivery(
    stored: StoredStateMutationOutboxRecord,
    readers: StateMutationOutboxSnapshotReaders,
): Promise<StateMutationOutboxDeliveryRead> {
    if (stored.record.kind === 'client') {
        const snapshot = await readers.readClientSnapshot(
            stored.record.aggregateRef,
        );
        return {
            stored,
            snapshot: snapshot
                ? { kind: 'client', snapshot }
                : { kind: 'missing' },
        };
    }

    const snapshot = await readers.readGroupSnapshot(
        stored.record.aggregateRef,
    );
    return {
        stored,
        snapshot: snapshot
            ? { kind: 'group', snapshot }
            : { kind: 'missing' },
    };
}

export function computeStateMutationOutboxDelivery(
    read: StateMutationOutboxDeliveryRead,
): StateMutationOutboxDeliveryPlan {
    if (read.snapshot.kind === 'missing') {
        return {
            stored: read.stored,
            snapshot: null,
            deliveredSnapshotRevision: -1,
        };
    }
    return {
        stored: read.stored,
        snapshot: read.snapshot.snapshot,
        deliveredSnapshotRevision: read.snapshot.snapshot.stateRevision,
    };
}

export function validateStateMutationOutboxDelivery(
    plan: StateMutationOutboxDeliveryPlan,
): void {
    const record = plan.stored.record;
    if (!plan.snapshot) {
        throw new Error(
            `State mutation outbox snapshot is unavailable for ${record.outboxId}`,
        );
    }
    if (plan.deliveredSnapshotRevision < record.acceptedCausalRevision.stateRevision) {
        throw new Error(
            `State mutation outbox snapshot is older than intent for ${record.outboxId}`,
        );
    }

    if (record.kind === 'client') {
        if (!('principal' in plan.snapshot)) {
            throw new Error(`Client outbox resolved a group snapshot: ${record.outboxId}`);
        }
        assertClientSnapshotCompatible(record, plan.snapshot);
        return;
    }
    if (!('group' in plan.snapshot)) {
        throw new Error(`Group outbox resolved a client snapshot: ${record.outboxId}`);
    }
    assertGroupSnapshotCompatible(record, plan.snapshot);
}

export type WriteStateMutationOutboxDeliveryPhaseInput = Readonly<{
    stored: StoredStateMutationOutboxRecord;
    attemptedAtEpochMs: number;
    outcome:
        | Readonly<{
            status: 'delivered';
            deliveredSnapshotRevision: number;
        }>
        | Readonly<{
            status: 'retryable';
            error: string;
        }>;
}>;

export type WriteStateMutationOutboxDeliveryPhaseResult =
    | Readonly<{ status: 'delivered' }>
    | Readonly<{
        status: 'conflict';
        current: StoredStateMutationOutboxRecord | null;
    }>
    | Readonly<{ status: 'retryable' }>;

export async function writeStateMutationOutboxDelivery(
    repository: StateMutationOutboxRepository,
    input: WriteStateMutationOutboxDeliveryPhaseInput,
): Promise<WriteStateMutationOutboxDeliveryPhaseResult> {
    const attempts = input.outcome.status === 'delivered'
        ? {
            count: input.stored.record.attempts.count + 1,
            last: {
                status: 'succeeded' as const,
                attemptedAtEpochMs: input.attemptedAtEpochMs,
            },
        }
        : {
            count: input.stored.record.attempts.count + 1,
            last: {
                status: 'failed' as const,
                attemptedAtEpochMs: input.attemptedAtEpochMs,
                error: input.outcome.error,
            },
        };
    const delivery = input.outcome.status === 'delivered'
        ? {
            status: 'delivered' as const,
            deliveredAtEpochMs: input.attemptedAtEpochMs,
            deliveredSnapshotRevision:
                input.outcome.deliveredSnapshotRevision,
        }
        : { status: 'retryable' as const };
    const write = await repository.writeDelivery({
        outboxId: input.stored.record.outboxId,
        expectedStorageRevision: input.stored.storageRevision,
        attempts,
        delivery,
    });
    if (write.status === 'applied') {
        return input.outcome.status === 'delivered'
            ? { status: 'delivered' }
            : { status: 'retryable' };
    }

    const current = write.current ??
        (await repository.find(input.stored.record.outboxId)) ?? null;
    if (current?.record.delivery.status === 'delivered') {
        return { status: 'delivered' };
    }
    return {
        status: 'conflict',
        current,
    };
}

async function enqueueStateMutationOutboxDelivery(
    plan: StateMutationOutboxDeliveryPlan,
    stateSyncPublisher: StateSyncPublisher,
    groupPresenceSummaryPublisher: GroupPresenceSummaryWorkPublisher | undefined,
    rtcTopologyPublisher: RtcTopologyStateMutationPublisher | undefined,
    senderId: string,
): Promise<number> {
    const record = plan.stored.record;
    const snapshot = plan.snapshot!;
    const acceptedSnapshotRevision =
        record.acceptedCausalRevision.stateRevision;
    const effectiveSnapshotRevisions: number[] = [];
    if (record.kind === 'client') {
        if (record.effects.includes('client-state-sync')) {
            const clientSnapshot = snapshot as ClientSnapshot;
            const result = await stateSyncPublisher.publishClientSnapshot(
                clientSnapshot,
                senderId,
                toStateMutationDeliveryId(
                    record.outboxId,
                    'client-state-sync',
                    'snapshot',
                ),
            );
            effectiveSnapshotRevisions.push(
                readEffectiveSnapshotRevision(
                    result,
                    acceptedSnapshotRevision,
                    record.outboxId,
                ),
            );
            if (record.event.kind === 'client') {
                await stateSyncPublisher.publishClientEvent(
                    record.event.event,
                    senderId,
                    toStateMutationDeliveryId(
                        record.outboxId,
                        'client-state-sync',
                        'event',
                        record.event.event.eventId,
                    ),
                );
            }
        }
        return Math.min(...effectiveSnapshotRevisions);
    }

    const groupSnapshot = snapshot as GroupSnapshot;
    if (record.effects.includes('group-state-sync')) {
        const result = await stateSyncPublisher.publishGroupSnapshot(
            groupSnapshot,
            senderId,
            toStateMutationDeliveryId(
                record.outboxId,
                'group-state-sync',
                'snapshot',
            ),
        );
        effectiveSnapshotRevisions.push(
            readEffectiveSnapshotRevision(
                result,
                acceptedSnapshotRevision,
                record.outboxId,
            ),
        );
        if (record.event.kind === 'group') {
            await stateSyncPublisher.publishGroupEvent(
                record.event.event,
                senderId,
                toStateMutationDeliveryId(
                    record.outboxId,
                    'group-state-sync',
                    'event',
                    record.event.event.eventId,
                ),
            );
        }
    }
    if (record.effects.includes('group-presence-summary')) {
        if (!groupPresenceSummaryPublisher) {
            throw new Error(
                `Group presence summary outbox adapter is unavailable for ${record.outboxId}`,
            );
        }
        const result = await groupPresenceSummaryPublisher
            .enqueueForGroupSnapshot(
                groupSnapshot,
                toStateMutationDeliveryId(
                    record.outboxId,
                    'group-presence-summary',
                    'snapshot',
                ),
            );
        effectiveSnapshotRevisions.push(
            readEffectiveSnapshotRevision(
                result,
                acceptedSnapshotRevision,
                record.outboxId,
            ),
        );
    }
    if (record.effects.includes('rtc-topology-recompute')) {
        if (!rtcTopologyPublisher) {
            throw new Error(
                `RTC topology outbox adapter is unavailable for ${record.outboxId}`,
            );
        }
        const result = await rtcTopologyPublisher.enqueueForStateMutation(
            groupSnapshot,
            toStateMutationDeliveryId(
                record.outboxId,
                'rtc-topology-recompute',
                'snapshot',
            ),
        );
        effectiveSnapshotRevisions.push(
            readEffectiveSnapshotRevision(
                result,
                acceptedSnapshotRevision,
                record.outboxId,
            ),
        );
    }
    return Math.min(...effectiveSnapshotRevisions);
}

function toStateMutationDeliveryId(
    outboxId: string,
    effect: StateMutationOutboxRecord['effects'][number],
    payloadKind: 'snapshot' | 'event',
    payloadId?: string,
): string {
    return [outboxId, effect, payloadKind, payloadId]
        .filter((part) => part !== undefined)
        .join(':');
}

function readEffectiveSnapshotRevision(
    result: void | StateMutationEffectEnqueueResult,
    acceptedSnapshotRevision: number,
    outboxId: string,
): number {
    // Legacy adapters return void. The immutable accepted revision is then the
    // only rigorously guaranteed lower bound; never substitute a later reread.
    const effectiveSnapshotRevision = result?.effectiveSnapshotRevision ??
        acceptedSnapshotRevision;
    if (
        !Number.isSafeInteger(effectiveSnapshotRevision) ||
        effectiveSnapshotRevision < acceptedSnapshotRevision
    ) {
        throw new TypeError(
            `State mutation outbox adapter returned an invalid winner revision for ${outboxId}`,
        );
    }
    return effectiveSnapshotRevision;
}

function assertClientSnapshotCompatible(
    record: Extract<StateMutationOutboxRecord, { kind: 'client' }>,
    snapshot: ClientSnapshot,
): void {
    const accepted = record.acceptedCausalRevision;
    if (
        snapshot.principal.applicationId !== record.aggregateRef.applicationId ||
        snapshot.principal.workspaceId !== record.aggregateRef.workspaceId ||
        snapshot.principal.principalId !== record.aggregateRef.principalId
    ) {
        throw new Error(`Client outbox snapshot has the wrong aggregate ref: ${record.outboxId}`);
    }
    if (
        snapshot.principal.snapshotVersion < accepted.snapshotVersion ||
        snapshot.principal.presenceVersion < accepted.presenceVersion
    ) {
        throw new Error(`Client outbox snapshot has an older causal tuple: ${record.outboxId}`);
    }
    if (record.event.kind === 'client') {
        const event = record.event.event;
        if (
            event.applicationId !== record.aggregateRef.applicationId ||
            event.workspaceId !== record.aggregateRef.workspaceId ||
            event.principalId !== record.aggregateRef.principalId ||
            event.snapshotVersion !== accepted.snapshotVersion
        ) {
            throw new Error(`Client outbox event does not match its intent: ${record.outboxId}`);
        }
    }
}

function assertGroupSnapshotCompatible(
    record: Extract<StateMutationOutboxRecord, { kind: 'group' }>,
    snapshot: GroupSnapshot,
): void {
    const accepted = record.acceptedCausalRevision;
    if (
        snapshot.group.applicationId !== record.aggregateRef.applicationId ||
        snapshot.group.workspaceId !== record.aggregateRef.workspaceId ||
        snapshot.group.groupId !== record.aggregateRef.groupId
    ) {
        throw new Error(`Group outbox snapshot has the wrong aggregate ref: ${record.outboxId}`);
    }
    if (
        snapshot.group.snapshotVersion < accepted.snapshotVersion ||
        snapshot.group.metadataVersion < accepted.metadataVersion ||
        snapshot.group.rosterVersion < accepted.rosterVersion ||
        snapshot.group.presenceVersion < accepted.presenceVersion
    ) {
        throw new Error(`Group outbox snapshot has an older causal tuple: ${record.outboxId}`);
    }
    if (record.event.kind === 'group') {
        const event = record.event.event;
        if (
            event.applicationId !== record.aggregateRef.applicationId ||
            event.workspaceId !== record.aggregateRef.workspaceId ||
            event.groupId !== record.aggregateRef.groupId ||
            event.snapshotVersion !== accepted.snapshotVersion
        ) {
            throw new Error(`Group outbox event does not match its intent: ${record.outboxId}`);
        }
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
