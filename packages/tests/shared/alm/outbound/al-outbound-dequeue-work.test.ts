import { Temporal } from '@js-temporal/polyfill';
import type { ALOutboundDropReasonCode } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import { waitForSettledOutboundWork } from '../../wait-for-al-outbound-work.ts';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    drainEngine,
    peekOutboundWorkReadyAt,
    runOutboundWorkTask
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
                dropReasonCode: undefined,
                persist: true,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);
                return { status: 'sent' as const, submissionAttempted: true };
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

    it.each(['not-yet-in-sync', 'unauthorized', 'planner-drop'] as const satisfies readonly ALOutboundDropReasonCode[])(
        'completes a %s dequeue without publishing the row',
        async (dropReasonCode) => {
            const outbox = createOutboxQueue();
            const published: string[] = [];
            const runtime = createDefaultOutboundTestRuntime({
                outbox,
                dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
                planOutgoingMessage: (msg) => ({
                    msg,
                    dropReason: 'Dropped before a route exists',
                    dropReasonCode,
                    persist: false,
                    preparedMessages: []
                }),
                afterDequeueAdmission: async (msg) => {
                    published.push(msg.id.msgId);
                },
                sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
            });
            const message = createDequeuedMessage(`discarded-${dropReasonCode}`);
            const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE);
            await outbox.enqueueIfAbsent(queued);

            await runtime.ready();

            expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.COMPLETED);
            expect(published).toEqual([]);
        }
    );

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
                    ? { msg, dropReasonCode: undefined, persist: false, preparedMessages: [] }
                    : {
                        msg: { ...msg, id: { ...msg.id, senderId: 'other-sender' } },
                        dropReasonCode: undefined,
                        persist: false,
                        preparedMessages: []
                    },
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
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

    it('retries a dequeue re-planned to no-route only up to the work attempt cap, then ends it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const outbox = createOutboxQueue();
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            // The RTC origin that owns no child re-plans a queued send to no-route (R-S2c-ii-9a).
            planOutgoingMessage: (msg) => ({
                msg,
                dropReason: 'No outbound transport route',
                dropReasonCode: 'no-route',
                persist: false,
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });
        const stranded = newALUnicastMessage(
            'server',
            { topicId: 'chat', resourceId: 'stranded', contextId: 'conversation-1' },
            'peer-1',
            'chat.private-text.v1',
            { text: 'stranded' },
            { ttlMs: 3_600_000 }
        );
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(stranded, DEQUEUE_TYPE);
        await outbox.enqueueIfAbsent(queued);
        await runtime.ready();

        // Each round passes the longest retry delay and the breaker opening, so only the cap can stop it.
        for (let round = 0; round < 2 * DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts; round += 1) {
            vi.setSystemTime(Date.now() + DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxDelayMs + 1_000);
            await runOutboundWorkTask(runtime);
        }

        const ended = await outbox.getItem(queued.key);
        expect(ended?.dequeueAudit.attempts).toBe(DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts);
        expect([EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED]).not.toContain(ended?.status);
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
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
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
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
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
