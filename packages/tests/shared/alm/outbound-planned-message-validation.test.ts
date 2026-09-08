import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    createDefaultOutboundTestAdmissionStore,
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';

const malformedMessages = [undefined, {}, { id: { msgId: 'malformed' } }];

describe('outbound planner validation boundary', () => {
    it.each(malformedMessages)('returns failure before using malformed planner message %j', async (planned) => {
        const store = createDefaultOutboundTestAdmissionStore();
        const outbox = new InMemoryQueueBox();
        const original = createOutboundMessage('invalid-planner');
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore: store },
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' }),
            planOutgoingMessage: () => ({ msg: planned as ALMessage, persist: true, preparedMessages: [] })
        });
        const result = await runtime.enqueueIfAbsent(original);
        expect(result).toMatchObject({ status: 'failed', message: original, entries: [] });
        expect(await store.readSentMessage(original.id.msgId)).toBeUndefined();
        expect(await store.peekNextEffectReadyAt()).toBeUndefined();
        expect(await outbox.getItem(QueueBoxUtilities.toResourceEntryFromMsg(original, 'outbox').key)).toBeUndefined();
    });

    it.each(malformedMessages)('rejects owned work with malformed planner message %j without retry', async (planned) => {
        const outbox = new InMemoryQueueBox();
        const original = createOutboundMessage('invalid-owned-planner');
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(original, 'outbox');
        await outbox.enqueue(entry);
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' }),
            planOutgoingMessage: () => ({ msg: planned as ALMessage, persist: true, preparedMessages: [] })
        });
        await runtime.dequeue(
            new Set(['outbox']),
            ResourceInboxResilience.createDefault({
                circuitBreakerPolicy: new CircuitBreakerPolicy(
                    10,
                    Temporal.Duration.from('PT1S'),
                    Temporal.Duration.from('PT1S'),
                    Temporal.Duration.from('PT1S')
                ),
                initialRate: 1,
                maxRate: 10,
                concurrencyIncreaseStep: 1,
                concurrencyReduceStep: 1
            })
        );
        expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
    });

    it.each(['payload', 'identity', 'authority', 'unchanged'] as const)('validates %s before a no-route result', async (change) => {
        const original = createOutboundMessage('no-route-validation');
        const planned: ALMessage = change === 'payload'
            ? { ...original, payload: { ...original.payload, resource: '{"changed":true}' } }
            : change === 'identity'
            ? { ...original, id: { ...original.id, msgId: 'other' } }
            : change === 'authority'
            ? { ...original, targets: { mode: 'unicast', toPeerId: 'other' } }
            : original;
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => ({ status: 'sent' }),
            planOutgoingMessage: () => ({ msg: planned, persist: false, preparedMessages: [], dropReason: 'No route' })
        });
        const result = await runtime.enqueueIfAbsent(original);
        expect(result.status).toBe(change === 'unchanged' ? 'no-route' : 'failed');
        expect(result.message).toEqual(original);
    });
});
