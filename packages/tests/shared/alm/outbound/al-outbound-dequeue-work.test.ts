import { Temporal } from '@js-temporal/polyfill';
import {
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
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

import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import { waitForSettledOutboundWork } from '../../wait-for-al-outbound-work.ts';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    drainEngine,
    peekOutboundWorkReadyAt
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const DEQUEUE_TYPE = 'WS_OUTBOX';

function createDequeueResilience(maxConsecutiveFailures = 10, openMs = 500): ResourceInboxResilience {
    const open = Temporal.Duration.from({ milliseconds: openMs });
    const window = Temporal.Duration.from({ milliseconds: 500 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(maxConsecutiveFailures, open, open, window),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}

function createOutboxQueue(): InMemoryQueueBox {
    return new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
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
        // The batch reschedules the no-route row 1 ms out, and the admission the failed row commits
        // owes a follow-up batch: a queue clock that never reaches that retry is what keeps the
        // follow-up from re-claiming the row before the budget assertion reads it.
        const observedAtMs = Date.now();
        const outbox = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(observedAtMs)
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

        await runtime.ready();

        const retried = await outbox.getItem(noRoute.key);
        expect(retried?.status).toBe(EntityStatus.RETRY);
        expect(retried?.dequeueAudit.attempts).toBe(1);
        expect((await outbox.getItem(failed.key))?.status).toBe(EntityStatus.NON_RETRYABLE);
    });

    it('charges the dequeue breaker for the rejections the work handler swallows', async () => {
        const outbox = createOutboxQueue();
        const resilience = createDequeueResilience(2);
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience },
            // A rewritten sender fails validation, which the dequeue path rethrows as non-retryable.
            planOutgoingMessage: (msg) => ({
                msg: { ...msg, id: { ...msg.id, senderId: 'other-sender' } },
                persist: false,
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent' as const })
        });
        for (const resourceId of ['charged-1', 'charged-2', 'charged-3']) {
            await outbox.enqueueIfAbsent(
                QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(resourceId), DEQUEUE_TYPE)
            );
        }

        await runtime.ready();

        expect(resilience.isNotAllowedThroughToDequeue()).toBe(true);
    });

    it('advertises no dequeue work while the breaker is open and claims again once it half-opens', async () => {
        const outbox = createOutboxQueue();
        const resilience = createDequeueResilience(2, 40);
        const queueEngine = new InboxOutboxEngine();
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            queueEngine,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience },
            planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] }),
            sendPreparedMessage: async () => ({ status: 'sent' as const })
        });
        await runtime.ready();
        for (let charge = 0; charge < 3; charge += 1) {
            resilience.failure();
        }
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('gated'), DEQUEUE_TYPE);
        await outbox.enqueueIfAbsent(queued);

        await drainEngine(queueEngine);
        expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.NEW);

        await expect.poll(async () => {
            await drainEngine(queueEngine);
            return (await outbox.getItem(queued.key))?.status;
        }).not.toBe(EntityStatus.NEW);
    });

    it('advertises no readiness for a full page of expired work', async () => {
        const stores = createDefaultOutboundTestStores();
        const expiredAtMs = Date.now() - 1_000;
        for (let index = 0; index <= AL_OUTBOUND_WORK_PAGE_SIZE; index += 1) {
            await stores.workQueue.enqueueIfAbsent(computeALOutboundWorkEntry({
                namespace: stores.admissionStore.namespace,
                effectId: `expired-${index}`,
                payload: { kind: 'ack-timeout', msgId: `expired-${index}` },
                observedAtMs: expiredAtMs - 1_000,
                retryAtMs: expiredAtMs - 1_000,
                expireAtTimestamp: expiredAtMs
            }));
        }

        expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace))
            .toBeUndefined();
    });
});
