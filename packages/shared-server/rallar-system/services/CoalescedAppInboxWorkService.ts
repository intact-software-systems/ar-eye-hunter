import { Temporal } from '@js-temporal/polyfill';
import { type ALMessage, newALRoute, newALUntargetedMessage, } from '@shared/al-contracts/al-contract.ts';
import {
    COMPLETED_STATUSES,
    EntityStatus,
    isFailed,
    type Key,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

export const COALESCED_APP_INBOX_WORK_FIELD = '__rallarCoalescedWork';

export type CoalescedAppInboxWorkMetadata = Readonly<{
    generation: number;
    requestedAtEpochMs: number;
    dueAtEpochMs: number;
    reasons: readonly string[];
}>;

export type CoalescedAppInboxWorkData<T extends object> =
    & T
    & Readonly<{
    [COALESCED_APP_INBOX_WORK_FIELD]: CoalescedAppInboxWorkMetadata;
}>;

export type CoalescedAppInboxWorkEnvelope<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId: string;
    data: CoalescedAppInboxWorkData<T>;
}>;

export type CoalescedAppInboxWorkMerge<T extends object> = (
    existing: CoalescedAppInboxWorkData<T>,
    incoming: CoalescedAppInboxWorkData<T>,
    previousEntry: ResourceEntry,
) => CoalescedAppInboxWorkData<T>;

export type CoalescedAppInboxWorkEnqueueInput<T extends object> = Readonly<{
    type: string;
    topicId: string;
    resourceId: string;
    contextId: string;
    senderId?: string;
    data: T;
    reason?: string;
    requestedAtEpochMs?: number;
    dueAtEpochMs?: number;
    merge?: CoalescedAppInboxWorkMerge<T>;
}>;

export type CoalescedAppInboxWorkEnqueueResult<T extends object> = Readonly<{
    action: 'inserted' | 'updated' | 'unchanged';
    entry: ResourceEntry;
    previous?: ResourceEntry;
    envelope: CoalescedAppInboxWorkEnvelope<T>;
}>;

export class CoalescedAppInboxWorkService {
    constructor(
        private readonly inbox: InboxQueueReader,
        private readonly serviceId: string = 'rallar-server',
        private readonly now: () => number = () => Date.now(),
    ) {
    }

    async enqueue<T extends object>(
        input: CoalescedAppInboxWorkEnqueueInput<T>,
    ): Promise<CoalescedAppInboxWorkEnqueueResult<T>> {
        const now = input.requestedAtEpochMs ?? this.now();
        const incoming = this.createEnvelope(input, now, 1);
        const initialEntry = this.toScheduledEntry(
            this.toQueueEntry(incoming),
            incoming.data[COALESCED_APP_INBOX_WORK_FIELD].dueAtEpochMs,
            now,
        );
        const result = await this.inbox.inbox.enqueueOrUpdate(
            initialEntry,
            (previous) => {
                const previousEnvelope = this.tryReadEnvelope<T>(previous);
                if (!previousEnvelope) {
                    return initialEntry;
                }

                const isTerminal = isTerminalCoalescedStatus(previous.status);
                const previousMetadata =
                    previousEnvelope.data[COALESCED_APP_INBOX_WORK_FIELD];
                const mergedData = !isTerminal && input.merge
                    ? input.merge(previousEnvelope.data, incoming.data, previous)
                    : incoming.data;
                const nextEnvelope: CoalescedAppInboxWorkEnvelope<T> = {
                    ...incoming,
                    data: {
                        ...mergedData,
                        [COALESCED_APP_INBOX_WORK_FIELD]: {
                            ...mergedData[COALESCED_APP_INBOX_WORK_FIELD],
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
                        nextEnvelope.data[COALESCED_APP_INBOX_WORK_FIELD]
                            .dueAtEpochMs,
                        now,
                    );
                }

                return {
                    ...this.toScheduledEntry(
                        nextEntry,
                        nextEnvelope.data[COALESCED_APP_INBOX_WORK_FIELD]
                            .dueAtEpochMs,
                        now,
                    ),
                    audit: previous.audit,
                };
            },
        );

        const envelope = this.readEnvelope<T>(result.entry);
        return {
            ...result,
            envelope,
        };
    }

    async isReservedEntryStale(entry: ResourceEntry): Promise<boolean> {
        const current = await this.inbox.inbox.getItem(entry.key);
        if (!current) {
            return false;
        }

        return this.readGeneration(current) > this.readGeneration(entry);
    }

    readEnvelope<T extends object>(
        entry: ResourceEntry,
    ): CoalescedAppInboxWorkEnvelope<T> {
        const envelope = this.tryReadEnvelope<T>(entry);
        if (!envelope) {
            throw new Error(
                `Resource entry is not a coalesced app inbox work item: ${
                    JSON.stringify(entry.key)
                }`,
            );
        }

        return envelope;
    }

    readMessage(entry: ResourceEntry): ALMessage {
        return JSON.parse(entry.resource) as ALMessage;
    }

    readGeneration(entry: ResourceEntry): number {
        return this.readEnvelope(entry).data[COALESCED_APP_INBOX_WORK_FIELD]
            .generation;
    }

    toKey(input: Pick<
        CoalescedAppInboxWorkEnqueueInput<object>,
        'topicId' | 'resourceId' | 'contextId'
    >): Key {
        return {
            topicId: input.topicId,
            resourceId: input.resourceId,
            contextId: input.contextId,
        };
    }

    private createEnvelope<T extends object>(
        input: CoalescedAppInboxWorkEnqueueInput<T>,
        requestedAtEpochMs: number,
        generation: number,
    ): CoalescedAppInboxWorkEnvelope<T> {
        const dueAtEpochMs = input.dueAtEpochMs ?? requestedAtEpochMs;
        return {
            type: input.type,
            topicId: input.topicId,
            resourceId: input.resourceId,
            contextId: input.contextId,
            senderId: input.senderId ?? this.serviceId,
            data: {
                ...input.data,
                [COALESCED_APP_INBOX_WORK_FIELD]: {
                    generation,
                    requestedAtEpochMs,
                    dueAtEpochMs,
                    reasons: input.reason ? [input.reason] : [],
                },
            } as CoalescedAppInboxWorkData<T>,
        };
    }

    private toQueueEntry<T extends object>(
        envelope: CoalescedAppInboxWorkEnvelope<T>,
    ): ResourceEntry {
        return QueueBoxUtilities.toResourceEntryFromMsg(
            newALUntargetedMessage(
                envelope.senderId,
                newALRoute(
                    envelope.topicId,
                    envelope.contextId,
                    envelope.resourceId,
                ),
                envelope.type,
                envelope,
            ),
            InboxQueueReader.INBOX_ENQUEUE_TYPE,
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
    ): CoalescedAppInboxWorkEnvelope<T> | undefined {
        try {
            const message = this.readMessage(entry);
            const envelope = JSON.parse(
                message.payload.resource,
            ) as CoalescedAppInboxWorkEnvelope<T>;
            if (!isCoalescedEnvelope(envelope)) {
                return undefined;
            }

            return envelope;
        } catch {
            return undefined;
        }
    }
}

function isTerminalCoalescedStatus(status: EntityStatus): boolean {
    return COMPLETED_STATUSES.has(status) || isFailed(status);
}

function isCoalescedEnvelope(value: unknown): value is CoalescedAppInboxWorkEnvelope<object> {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const maybe = value as Partial<CoalescedAppInboxWorkEnvelope<object>>;
    const data = maybe.data as Record<string, unknown> | undefined;
    const metadata = data?.[COALESCED_APP_INBOX_WORK_FIELD] as
        | Partial<CoalescedAppInboxWorkMetadata>
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
