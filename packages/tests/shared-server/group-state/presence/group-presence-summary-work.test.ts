import { Temporal } from '@js-temporal/polyfill';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { computeGroupPresenceSummaryEntry, type GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';

type ReservedSummary = Readonly<{
    entry: ResourceEntry;
    message: ALMessage;
}>;

type InvalidSummaryScenario = Readonly<{
    name: string;
    mutate(canonical: ReservedSummary): ReservedSummary;
}>;

const BASE_EPOCH_MS = Date.now();

const INVALID_SUMMARY_SCENARIOS: readonly InvalidSummaryScenario[] = [
    routeScenario('wrong persisted topic', (route) => ({
        ...route,
        topicId: 'app-outbox.wrong-summary'
    })),
    routeScenario('wrong persisted context identity', (route) => ({
        ...route,
        contextId: 'wrong-context'
    })),
    routeScenario('wrong persisted resource identity', (route) => ({
        ...route,
        resourceId: 'wrong-resource'
    })),
    messageScenario('outer payload type differs from nested envelope', (message) => ({
        ...message,
        payload: { ...message.payload, typeId: 'RTC_TOPOLOGY_RECOMPUTE' }
    })),
    envelopeScenario('missing mandatory envelope type', (envelope) => {
        const { type: _type, ...withoutType } = envelope;
        return withoutType;
    }),
    envelopeScenario('unknown mandatory envelope field', (envelope) => ({
        ...envelope,
        unknownEnvelopeFact: 'must-fail-closed'
    })),
    workScenario('missing mandatory work commandId', (work) => {
        const { commandId: _commandId, ...withoutCommandId } = work;
        return withoutCommandId;
    }),
    workScenario('unknown mandatory work field', (work) => ({
        ...work,
        unknownWorkFact: 'must-fail-closed'
    })),
    workScenario('divergent commandId and resourceId', (work) => ({
        ...work,
        commandId: 'divergent-command'
    })),
    workScenario('divergent accepted causal revision', (work) => ({
        ...work,
        acceptedCausalRevision: {
            ...CANONICAL_SUMMARY_WORK.acceptedCausalRevision,
            presenceRevision: CANONICAL_SUMMARY_WORK.acceptedCausalRevision.presenceRevision + 1
        }
    })),
    workScenario('divergent event identity', (work) => ({
        ...work,
        event: decodeJsonWireValue({
            ...CANONICAL_SUMMARY_WORK.event,
            groupId: 'wrong-event-group'
        }, 'Divergent group presence summary event')
    })),
    workScenario('divergent event body', (work) => ({
        ...work,
        event: decodeJsonWireValue({
            ...CANONICAL_SUMMARY_WORK.event,
            occurredAtEpochMs: CANONICAL_SUMMARY_WORK.createdAtEpochMs + 1
        }, 'Divergent group presence summary event')
    })),
    messageScenario('message timestamp mismatch', (message) => ({
        ...message,
        id: { ...message.id, ts: message.id.ts + 1 }
    })),
    messageScenario('message expiry mismatch', (message) => ({
        ...message,
        constraints: {
            ...message.constraints,
            expiresAtMs: (message.constraints?.expiresAtMs ?? 0) + 1
        }
    })),
    messageScenario('message ordering mismatch', (message) => ({
        ...message,
        ordering: {
            ...message.ordering,
            seq: (message.ordering?.seq ?? 0) + 1
        }
    })),
    messageScenario('message sender mismatch', (message) => ({
        ...message,
        id: { ...message.id, senderId: 'wrong-sender' }
    })),
    messageScenario('message audit mismatch', (message) => ({
        ...message,
        audit: {
            ...message.audit,
            createdTs: (message.audit?.createdTs ?? 0) + 1
        }
    })),
    entryScenario('entry audit sender mismatch', (entry) => ({
        ...entry,
        audit: { ...entry.audit, createdBy: 'wrong-sender' }
    })),
    entryScenario('entry audit timestamp mismatch', (entry) => ({
        ...entry,
        audit: {
            ...entry.audit,
            createdTs: Temporal.PlainDateTime.from('2000-01-01T00:00:00')
        }
    })),
    {
        name: 'persisted resource differs from delivered message',
        mutate: ({ entry, message }) => ({
            message,
            entry: { ...entry, resource: JSON.stringify({ divergent: true }) }
        })
    }
];

describe('GroupPresenceSummaryWork canonical persisted command', () => {
    it.each(INVALID_SUMMARY_SCENARIOS)('rejects $name before read or effects', async ({ mutate }) => {
        const begin = vi.fn();
        const wakeQueue = vi.fn();
        const worker = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            runtimeRepository: new FakeRuntimeStateRepository(),
            database: Object.assign(async () => undefined, { begin }) as never,
            serviceId: 'summary-handler',
            wakeQueue,
            now: () => 5_000
        });
        const read = vi
            .spyOn(worker, 'read')
            .mockRejectedValue(new Error('summary read must not run for malformed work'));
        const compute = vi.spyOn(worker, 'compute');
        const write = vi.spyOn(worker, 'write');
        const { message, entry } = mutate(createCanonicalReservation());

        await expect(worker.processReservedEntry(message, entry)).rejects.toMatchObject({
            name: 'NonRetryableException',
            message: 'Presence-summary work payload is malformed'
        });
        expect(read).not.toHaveBeenCalled();
        expect(compute).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(wakeQueue).not.toHaveBeenCalled();
    });

    it('exposes single-attempt presence-summary phases for a queue-owned transaction', () => {
        const work = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            runtimeRepository: new GroupBarrierRepository(),
            now: () => BASE_EPOCH_MS,
            serviceId: 'summary-worker'
        });

        expect(work).toMatchObject({
            read: expect.any(Function),
            compute: expect.any(Function),
            validate: expect.any(Function),
            write: expect.any(Function),
            processReservedEntry: expect.any(Function)
        });
        expect(Reflect.get(work, 'converge')).toBeUndefined();
        expect(Reflect.get(work, 'enqueueForGroupSnapshot')).toBeUndefined();
    });
});

const CANONICAL_SUMMARY_WORK: GroupPresenceSummaryWorkData = {
    effectKind: 'group-presence-summary',
    aggregateRef: {
        applicationId: 'summary-app',
        workspaceId: 'main',
        groupId: 'summary-group'
    },
    commandId: 'summary-command',
    createdAtEpochMs: 1_000,
    expireAtEpochMs: 100_000,
    acceptedCausalRevision: {
        groupRevision: 4,
        presenceRevision: 3
    },
    event: {
        applicationId: 'summary-app',
        workspaceId: 'main',
        groupId: 'summary-group',
        eventId: 'summary-event',
        eventType: 'session-connected',
        snapshotVersion: 4,
        causalRevision: {
            groupRevision: 4,
            presenceRevision: 3
        },
        occurredAtEpochMs: 1_000,
        actor: { kind: 'service', serviceId: 'summary-handler' },
        reason: null,
        traceId: null,
        requestId: 'summary-command',
        payload: {}
    }
};

function createCanonicalReservation(): ReservedSummary {
    const queued = computeGroupPresenceSummaryEntry(CANONICAL_SUMMARY_WORK, 'summary-handler');
    const entry: ResourceEntry = {
        ...queued,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts: 1,
            startTs: Temporal.Instant.fromEpochMilliseconds(2_000)
        }
    };
    return {
        entry,
        message: JSON.parse(entry.resource) as ALMessage
    };
}

function routeScenario(
    name: string,
    update: (route: ALMessage['route']) => ALMessage['route']
): InvalidSummaryScenario {
    return {
        name,
        mutate: ({ entry, message }) => {
            const route = update(message.route);
            const updatedMessage = { ...message, route };
            return {
                message: updatedMessage,
                entry: {
                    ...entry,
                    key: route,
                    resource: JSON.stringify(updatedMessage)
                }
            };
        }
    };
}

function messageScenario(
    name: string,
    update: (message: ALMessage) => ALMessage
): InvalidSummaryScenario {
    return {
        name,
        mutate: ({ entry, message }) => {
            const updatedMessage = update(message);
            return {
                message: updatedMessage,
                entry: { ...entry, resource: JSON.stringify(updatedMessage) }
            };
        }
    };
}

function envelopeScenario(
    name: string,
    update: (envelope: JsonWireObject) => JsonWireObject
): InvalidSummaryScenario {
    return messageScenario(name, (message) => {
        const envelope = decodeJsonWireObject(JSON.parse(message.payload.resource), 'Group presence summary envelope');
        return {
            ...message,
            payload: {
                ...message.payload,
                resource: JSON.stringify(update(envelope))
            }
        };
    });
}

function workScenario(
    name: string,
    update: (work: JsonWireObject) => JsonWireObject
): InvalidSummaryScenario {
    return envelopeScenario(name, (envelope) => ({
        ...envelope,
        data: update(decodeJsonWireObject(envelope.data, 'Group presence summary work'))
    }));
}

function decodeJsonWireObject(value: unknown, label: string): JsonWireObject {
    const decoded = decodeJsonWireValue(value, label);
    if (!isJsonWireObject(decoded)) {
        throw new TypeError(`${label} must be an object`);
    }
    return decoded;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function entryScenario(
    name: string,
    update: (entry: ResourceEntry) => ResourceEntry
): InvalidSummaryScenario {
    return {
        name,
        mutate: ({ entry, message }) => ({ entry: update(entry), message })
    };
}
