import { Temporal } from '@js-temporal/polyfill';
import {
    EntityStatus,
    InMemoryQueueBox,
    newALUnicastMessage,
    QueueBoxUtilities,
    type ALMessage
} from '@shared/mod.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { describe, expect, it } from 'vitest';

import { waitForSettledOutboundWork } from '../../wait-for-al-outbound-work.ts';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const DEQUEUE_TYPE = 'WS_OUTBOX';

function createDequeueResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ milliseconds: 500 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}

function createDequeuedMessage(resourceId: string): ALMessage {
    return newALUnicastMessage(
        'server',
        { topicId: 'chat', resourceId, contextId: 'conversation-1' },
        'peer-1',
        'chat.private-text.v1',
        { text: resourceId },
        { ttlMs: 30_000 }
    );
}

describe('AL outbound dequeue work', () => {
    it('claims a foreign outbox row as dequeue-message work and admits it through the planner', async () => {
        const outbox = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(Date.now())
        );
        const stores = createDefaultOutboundTestStores(outbox);
        const sent: OutboundTestPayload[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            planOutgoingMessage: (msg) => ({
                msg,
                persist: true,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);
                return { status: 'sent' as const };
            }
        });
        const message = createDequeuedMessage('dequeue-admits');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE);
        await outbox.enqueueIfAbsent(queued);

        await runtime.ready();
        await waitForSettledOutboundWork(stores.workQueue, stores.admissionStore.namespace, new Set([DEQUEUE_TYPE]));

        expect(sent.map((prepared) => prepared.msgId)).toEqual([message.id.msgId]);
        expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it('keeps a no-route dequeue on the retry budget and a failed admission non-retryable', async () => {
        const outbox = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(Date.now())
        );
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            planOutgoingMessage: (msg) =>
                msg.route.resourceId === 'no-route'
                    ? { msg, persist: false, preparedMessages: [] }
                    : {
                        msg: { ...msg, id: { ...msg.id, senderId: 'other-sender' } },
                        persist: false,
                        preparedMessages: []
                    },
            sendPreparedMessage: async () => ({ status: 'sent' as const })
        });
        const noRoute = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('no-route'), DEQUEUE_TYPE);
        const failed = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('failed'), DEQUEUE_TYPE);
        await outbox.enqueueIfAbsent(noRoute);
        await outbox.enqueueIfAbsent(failed);

        // One batch only: the retry budget assertion counts this attempt, not later engine passes.
        await runtime.ready();

        const retried = await outbox.getItem(noRoute.key);
        expect(retried?.status).toBe(EntityStatus.RETRY);
        expect(retried?.dequeueAudit.attempts).toBe(1);
        expect((await outbox.getItem(failed.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
    });
});
