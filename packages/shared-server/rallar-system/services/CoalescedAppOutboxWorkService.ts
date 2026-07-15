import { Temporal } from '@js-temporal/polyfill';
import {
    type ALMessage,
    newALRoute,
    newALUntargetedMessage,
} from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    isFailed,
    type Key,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import {
    toAppQueueCreatedBy,
    toAppQueueKey,
} from './app-inbox-queue-key.ts';

export const COALESCED_APP_OUTBOX_WORK_FIELD = '__rallarCoalescedWork';

export type CoalescedAppOutboxWorkMetadata = Readonly<{
    generation: number;
    requestedAtEpochMs: number;
    dueAtEpochMs: number;
    reasons: readonly string[];
}>;

export type CoalescedAppOutboxWorkData<T extends object> =
    & T
    & Readonly<{
    [COALESCED_APP_OUTBOX_WORK_FIELD]: CoalescedAppOutboxWorkMetadata;
}>;

export type CoalescedAppOutboxWorkEnvelope<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId: string;
    data: CoalescedAppOutboxWorkData<T>;
}>;

export type CoalescedAppOutboxWorkMerge<T extends object> = (
    existing: CoalescedAppOutboxWorkData<T>,
    incoming: CoalescedAppOutboxWorkData<T>,
    previousEntry: ResourceEntry,
) => CoalescedAppOutboxWorkData<T>;

export type CoalescedAppOutboxWorkEnqueueInput<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId?: string;
    data: T;
    reason?: string;
    requestedAtEpochMs?: number;
    dueAtEpochMs?: number;
    merge?: CoalescedAppOutboxWorkMerge<T>;
}>;

export type CoalescedAppOutboxWorkEnqueueResult<T extends object> = Readonly<{
    action: 'inserted' | 'updated' | 'unchanged';
    entry: ResourceEntry;
    previous?: ResourceEntry;
    envelope: CoalescedAppOutboxWorkEnvelope<T>;
}>;

export class CoalescedAppOutboxWorkService {
    constructor(
        private readonly outbox: OutboxQueueReader,
        private readonly serviceId: string = 'rallar-server',
        private readonly now: () => number = () => Date.now(),
    ) {
    }

    async enqueue<T extends object>(
        input: CoalescedAppOutboxWorkEnqueueInput<T>,
    ): Promise<CoalescedAppOutboxWorkEnqueueResult<T>> {
        const now = input.requestedAtEpochMs ?? this.now();
        const incoming = this.createEnvelope(input, now, 1);
        const initialEntry = this.toScheduledEntry(
            this.toQueueEntry(incoming),
            incoming.data[COALESCED_APP_OUTBOX_WORK_FIELD].dueAtEpochMs,
            now,
        );
        const result = await this.outbox.outbox.enqueueOrUpdate(
            initialEntry,
            (previous) => {
                const previousEnvelope = this.tryReadEnvelope<T>(previous);
                if (!previousEnvelope) {
                    return initialEntry;
                }

                const isTerminal = isTerminalCoalescedStatus(previous.status);
                const previousMetadata =
                    previousEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
                const mergedData = !isTerminal && input.merge
                    ? input.merge(previousEnvelope.data, incoming.data, previous)
                    : incoming.data;
                const nextEnvelope: CoalescedAppOutboxWorkEnvelope<T> = {
                    ...incoming,
                    data: {
                        ...mergedData,
                        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
                            ...mergedData[COALESCED_APP_OUTBOX_WORK_FIELD],
                            generation: previousMetadata.generation + 1,
                            requestedAtEpochMs: now,
                        },
                    },
                };
                const nextEntry = this.toQueueEntry(nextEnvelope);

                if (previous.status === EntityStatus.RESERVED) {
                    return {
                        ...nextEntry,
                        audit: previous.audit,
                        status: EntityStatus.RESERVED,
                        dequeueAudit: previous.dequeueAudit,
                    };
                }

                if (isTerminal) {
                    return this.toScheduledEntry(
                        nextEntry,
                        nextEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]
                            .dueAtEpochMs,
                        now,
                    );
                }

                return {
                    ...this.toScheduledEntry(
                        nextEntry,
                        nextEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]
                            .dueAtEpochMs,
                        now,
                    ),
                    audit: previous.audit,
                };
            },
        );

        return {
            ...result,
            envelope: this.readEnvelope<T>(result.entry),
        };
    }

    async isReservedEntryStale(entry: ResourceEntry): Promise<boolean> {
        const current = await this.outbox.outbox.getItem(entry.key);
        if (!current) {
            return false;
        }

        return this.readGeneration(current) > this.readGeneration(entry);
    }

    readEnvelope<T extends object>(
        entry: ResourceEntry,
    ): CoalescedAppOutboxWorkEnvelope<T> {
        const envelope = this.tryReadEnvelope<T>(entry);
        if (!envelope) {
            throw new Error(
                `Resource entry is not a coalesced app outbox work item: ${JSON.stringify(entry.key)}`,
            );
        }

        return envelope;
    }

    readMessage(entry: ResourceEntry): ALMessage {
        return JSON.parse(entry.resource) as ALMessage;
    }

    readGeneration(entry: ResourceEntry): number {
        return this.readEnvelope(entry).data[COALESCED_APP_OUTBOX_WORK_FIELD]
            .generation;
    }

    toKey(input: Pick<
        CoalescedAppOutboxWorkEnqueueInput<object>,
        'topicId' | 'resourceId' | 'contextId'
    >): Key {
        return toAppQueueKey(input);
    }

    private createEnvelope<T extends object>(
        input: CoalescedAppOutboxWorkEnqueueInput<T>,
        requestedAtEpochMs: number,
        generation: number,
    ): CoalescedAppOutboxWorkEnvelope<T> {
        const dueAtEpochMs = input.dueAtEpochMs ?? requestedAtEpochMs;
        return {
            type: input.type,
            topicId: input.topicId,
            resourceId: input.resourceId,
            contextId: input.contextId,
            senderId: input.senderId ?? this.serviceId,
            data: {
                ...input.data,
                [COALESCED_APP_OUTBOX_WORK_FIELD]: {
                    generation,
                    requestedAtEpochMs,
                    dueAtEpochMs,
                    reasons: input.reason ? [input.reason] : [],
                },
            } as CoalescedAppOutboxWorkData<T>,
        };
    }

    private toQueueEntry<T extends object>(
        envelope: CoalescedAppOutboxWorkEnvelope<T>,
    ): ResourceEntry {
        const key = this.toKey(envelope);
        return QueueBoxUtilities.toResourceEntryFromMsg(
            newALUntargetedMessage(
                toAppQueueCreatedBy(envelope.senderId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                envelope.type,
                envelope,
            ),
            EnqueuedType.APP_OUTBOX,
        );
    }

    private toScheduledEntry(
        entry: ResourceEntry,
        dueAtEpochMs: number,
        now: number,
    ): ResourceEntry {
        const isDue = dueAtEpochMs <= now;
        return {
            ...entry,
            status: isDue ? EntityStatus.NEW : EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 0,
                nextTs: isDue
                    ? undefined
                    : Temporal.Instant.fromEpochMilliseconds(dueAtEpochMs),
            },
        };
    }

    private tryReadEnvelope<T extends object>(
        entry: ResourceEntry,
    ): CoalescedAppOutboxWorkEnvelope<T> | undefined {
        try {
            const message = this.readMessage(entry);
            const envelope = JSON.parse(
                message.payload.resource,
            ) as CoalescedAppOutboxWorkEnvelope<T>;
            return isCoalescedEnvelope(envelope) ? envelope : undefined;
        } catch {
            return undefined;
        }
    }
}

function isTerminalCoalescedStatus(status: EntityStatus): boolean {
    return COMPLETED_STATUSES.has(status) || isFailed(status);
}

function isCoalescedEnvelope(
    value: unknown,
): value is CoalescedAppOutboxWorkEnvelope<object> {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const maybe = value as Partial<CoalescedAppOutboxWorkEnvelope<object>>;
    const data = maybe.data as Record<string, unknown> | undefined;
    const metadata = data?.[COALESCED_APP_OUTBOX_WORK_FIELD] as
        | Partial<CoalescedAppOutboxWorkMetadata>
        | undefined;

    return typeof maybe.type === 'string' &&
        typeof maybe.topicId === 'string' &&
        typeof maybe.resourceId === 'string' &&
        typeof maybe.contextId === 'string' &&
        typeof maybe.senderId === 'string' &&
        typeof metadata?.generation === 'number' &&
        typeof metadata.requestedAtEpochMs === 'number' &&
        typeof metadata.dueAtEpochMs === 'number';
}
