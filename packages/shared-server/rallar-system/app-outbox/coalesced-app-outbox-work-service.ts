import { Temporal } from '@js-temporal/polyfill';
import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    isMutableCoalescedStatus,
    isTerminalCoalescedStatus,
    tryReadCoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkMetadata
} from '@shared/queuebox/coalesced-app-outbox-work-envelope.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '../../queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { replaceFinishedResourceEntryIfMatch } from '../../queuebox/postgres/resource-inbox-finished-replacement.ts';

export {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkData,
    type CoalescedAppOutboxWorkEnvelope,
    type CoalescedAppOutboxWorkMetadata,
    isMutableCoalescedStatus,
    isTerminalCoalescedStatus,
    tryReadCoalescedAppOutboxWorkEnvelope
};

export type CoalescedAppOutboxWorkMerge<T extends object> = (
    existing: CoalescedAppOutboxWorkData<T>,
    incoming: CoalescedAppOutboxWorkData<T>,
    previousEntry: ResourceEntry
) => CoalescedAppOutboxWorkData<T>;

export interface CoalescedAppOutboxWorkEnqueueInput<T extends object> {
    readonly type: string;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly senderId?: string;
    readonly data: T;
    readonly reason?: string;
    readonly requestedAtEpochMs?: number;
    readonly dueAtEpochMs?: number;
    readonly merge?: CoalescedAppOutboxWorkMerge<T>;
}

export interface CoalescedAppOutboxWorkEnqueueResult<T extends object> {
    readonly action: 'inserted' | 'updated' | 'unchanged';
    readonly entry: ResourceEntry;
    readonly previous?: ResourceEntry;
    readonly envelope: CoalescedAppOutboxWorkEnvelope<T>;
    readonly blockedByReserved: boolean;
}

export interface ComputedCoalescedAppOutboxWork {
    readonly expectedEntry: ResourceEntry | null;
    readonly entry: ResourceEntry;
    readonly successorEntry: ResourceEntry;
}

export interface CoalescedAppOutboxWorkWriteResult {
    readonly action: 'inserted' | 'matched' | 'updated' | 'successor';
    readonly entry: ResourceEntry;
    readonly previous: ResourceEntry | null;
    readonly blockedByReserved: boolean;
}

export class CoalescedAppOutboxWorkService {
    private readonly outbox: OutboxQueueReader;
    private readonly serviceId: string;
    private readonly now: () => number;

    constructor(
        outbox: OutboxQueueReader,
        serviceId: string = 'rallar-server',
        now: () => number = () => Date.now()
    ) {
        this.outbox = outbox;
        this.serviceId = serviceId;
        this.now = now;
    }

    async write(
        transaction: PSqlSql,
        computed: ComputedCoalescedAppOutboxWork
    ): Promise<CoalescedAppOutboxWorkWriteResult> {
        const repository = new PSqlResourceInboxEntryRepository(transaction);
        const expected = computed.expectedEntry;
        if (expected === null) {
            const action = await repository.writeIfAbsentOrMatch(computed.entry);
            return {
                action,
                entry: computed.entry,
                previous: null,
                blockedByReserved: false
            };
        }

        const expectedGeneration = this.readGeneration(expected);
        const nextGeneration = this.readGeneration(computed.entry);
        if (nextGeneration !== expectedGeneration + 1) {
            throw new TypeError(
                'Coalesced APP_OUTBOX write must advance exactly one generation'
            );
        }
        if (isTerminalCoalescedStatus(expected.status)) {
            const revived = await replaceFinishedResourceEntryIfMatch(transaction, {
                expected,
                next: computed.entry,
                expectedGeneration
            });
            if (revived !== null) {
                return {
                    action: 'updated',
                    entry: revived,
                    previous: expected,
                    blockedByReserved: false
                };
            }
            return await this.writeSuccessor(repository, computed, expected);
        }
        if (!isMutableCoalescedStatus(expected.status)) {
            return await this.writeSuccessor(repository, computed, expected);
        }
        const updated = await repository.replacePendingIfMatch(
            expected,
            computed.entry,
            expectedGeneration
        );
        if (updated !== null) {
            return {
                action: 'updated',
                entry: updated,
                previous: expected,
                blockedByReserved: false
            };
        }

        return await this.writeSuccessor(repository, computed, expected);
    }

    private async writeSuccessor(
        repository: PSqlResourceInboxEntryRepository,
        computed: ComputedCoalescedAppOutboxWork,
        expected: ResourceEntry
    ): Promise<CoalescedAppOutboxWorkWriteResult> {
        if (sameKey(computed.successorEntry.key, computed.entry.key)) {
            throw new TypeError(
                'Coalesced APP_OUTBOX successor must have a distinct queue identity'
            );
        }
        await repository.writeIfAbsentOrMatch(computed.successorEntry);
        return {
            action: 'successor',
            entry: computed.successorEntry,
            previous: expected,
            blockedByReserved: true
        };
    }

    async enqueue<T extends object>(
        input: CoalescedAppOutboxWorkEnqueueInput<T>
    ): Promise<CoalescedAppOutboxWorkEnqueueResult<T>> {
        const now = input.requestedAtEpochMs ?? this.now();
        const incoming = this.createEnvelope(input, now, 1);
        const initialEntry = this.toScheduledEntry(
            this.toQueueEntry(incoming),
            incoming.data[COALESCED_APP_OUTBOX_WORK_FIELD].dueAtEpochMs,
            now
        );
        let blockedByReserved = false;
        const result = await this.outbox.outbox.enqueueOrUpdate(
            initialEntry,
            (previous) => {
                const previousEnvelope = tryReadCoalescedAppOutboxWorkEnvelope<T>(previous);
                if (!previousEnvelope) {
                    return initialEntry;
                }

                const isTerminal = isTerminalCoalescedStatus(previous.status);
                const previousMetadata = previousEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
                if (previous.status === EntityStatus.RESERVED) {
                    blockedByReserved = true;
                    return previous;
                }
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
                            requestedAtEpochMs: now
                        }
                    }
                };
                const nextEntry = this.toQueueEntry(nextEnvelope);

                if (isTerminal) {
                    return this.toScheduledEntry(
                        nextEntry,
                        nextEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]
                            .dueAtEpochMs,
                        now
                    );
                }

                return {
                    ...this.toScheduledEntry(
                        this.toLifecyclePreservingEntry(nextEntry, previous),
                        nextEnvelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]
                            .dueAtEpochMs,
                        now
                    ),
                    audit: previous.audit
                };
            }
        );

        return {
            ...result,
            envelope: this.readEnvelope<T>(result.entry),
            blockedByReserved
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
        entry: ResourceEntry
    ): CoalescedAppOutboxWorkEnvelope<T> {
        const envelope = tryReadCoalescedAppOutboxWorkEnvelope<T>(entry);
        if (!envelope) {
            throw new Error(
                `Resource entry is not a coalesced app outbox work item: ${JSON.stringify(entry.key)}`
            );
        }

        return envelope;
    }

    readMessage(entry: ResourceEntry): ALMessage {
        return decodePersistedALMessage(entry.resource);
    }

    readGeneration(entry: ResourceEntry): number {
        return this.readEnvelope(entry).data[COALESCED_APP_OUTBOX_WORK_FIELD]
            .generation;
    }

    toKey(
        input: Pick<CoalescedAppOutboxWorkEnqueueInput<object>, 'topicId' | 'resourceId' | 'contextId'>
    ): Key {
        return toAppQueueKey(input);
    }

    private createEnvelope<T extends object>(
        input: CoalescedAppOutboxWorkEnqueueInput<T>,
        requestedAtEpochMs: number,
        generation: number
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
                    reasons: input.reason ? [input.reason] : []
                }
            } as CoalescedAppOutboxWorkData<T>
        };
    }

    private toQueueEntry<T extends object>(
        envelope: CoalescedAppOutboxWorkEnvelope<T>
    ): ResourceEntry {
        const key = this.toKey(envelope);
        return QueueBoxUtilities.toResourceEntryFromMsg(
            newALUntargetedMessage(
                toAppQueueCreatedBy(envelope.senderId),
                newALRoute(key.topicId, key.contextId, key.resourceId),
                envelope.type,
                envelope
            ),
            EnqueuedType.APP_OUTBOX
        );
    }

    /**
     * A merge keeps the predecessor row's entry audit, so the persisted
     * message must keep the predecessor's creation and expiry identity or the
     * merged entry stops satisfying the canonical work contract that release
     * idempotency checks. The latest request and due times live in the
     * coalesced metadata, not the message identity.
     */
    private toLifecyclePreservingEntry(
        entry: ResourceEntry,
        previous: ResourceEntry
    ): ResourceEntry {
        const message = decodePersistedALMessage(entry.resource);
        const previousMessage = decodePersistedALMessage(previous.resource);
        const identityPreserved: ALMessage = {
            ...message,
            id: { ...message.id, ts: previousMessage.id.ts },
            ...(previousMessage.constraints === undefined
                ? {}
                : { constraints: previousMessage.constraints }),
            ...(previousMessage.audit === undefined
                ? {}
                : { audit: previousMessage.audit })
        };
        return { ...entry, resource: JSON.stringify(identityPreserved) };
    }

    private toScheduledEntry(
        entry: ResourceEntry,
        dueAtEpochMs: number,
        now: number
    ): ResourceEntry {
        const isDue = dueAtEpochMs <= now;
        return {
            ...entry,
            status: isDue ? EntityStatus.NEW : EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 0,
                nextTs: isDue
                    ? undefined
                    : Temporal.Instant.fromEpochMilliseconds(dueAtEpochMs)
            }
        };
    }
}

function sameKey(left: Key, right: Key): boolean {
    return left.topicId === right.topicId &&
        left.resourceId === right.resourceId &&
        left.contextId === right.contextId;
}
