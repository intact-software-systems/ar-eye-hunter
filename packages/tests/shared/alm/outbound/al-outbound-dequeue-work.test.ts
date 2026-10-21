import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createRallarALOutboundDequeueTiming, toALOutboundDequeueTimingEvents } from '@shared-server/rallar-system/observability/al-outbound-dequeue-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundDropReasonCode } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundDequeuedAdmission } from '@shared/alm/outbound/lane/al-outbound-dequeued-admission.ts';
import {
    EntityStatus,
    InMemoryQueueBox,
    newALUnicastMessage,
    QueueBoxUtilities,
    type ALMessage,
    type ResourceEntry
} from '@shared/mod.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

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

function captureDequeueTiming(
    events: ALOutboundDequeuedAdmission.TimingEvent[]
): ALOutboundDequeuedAdmission.TimingSink {
    return (observation) => events.push(...toALOutboundDequeueTimingEvents(observation));
}

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
    it('attributes a held authority read and later ordered dispatch to the claimed queue key', async () => {
        const outbox = createOutboxQueue();
        const message = createDequeuedMessage('timed-dequeue');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        let publicationEntry: ResourceEntry | undefined;
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: captureDequeueTiming(timings),
            readDequeueAuthority: async () => {
                entered.resolve();
                await release.promise;
                return undefined;
            },
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            afterDequeueAdmission: async (_msg, entry) => {
                publicationEntry = entry;
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent(queued);
            const work = runOutboundWorkTask(runtime);
            await entered.promise;
            expect(timings.map((event) => event.stage)).toEqual([
                'reservation-return',
                'admission-start',
                'pending-authority-read-start',
                'pending-authority-read-end',
                'authority-read-start'
            ]);
            release.resolve();
            await work;
            await expect.poll(() => timings.some((event) => event.stage === 'ordered-dispatch-start')).toBe(true);
            expect(timings.map((event) => event.stage)).toEqual([
                'reservation-return',
                'admission-start',
                'pending-authority-read-start',
                'pending-authority-read-end',
                'authority-read-start',
                'authority-read-end',
                'admission-read-end',
                'admission-commit-start',
                'admission-commit-end',
                'ordered-dispatch-start',
                'admission-end',
                'attempt-settled'
            ]);
            expect(timings.every((event) =>
                event.key.topicId === queued.key.topicId &&
                event.key.resourceId === queued.key.resourceId &&
                event.key.contextId === queued.key.contextId &&
                event.attempts === 1
            )).toBe(true);
            expect(timings.find((event) => event.stage === 'ordered-dispatch-start')?.publicationKey)
                .toEqual(publicationEntry?.key);
        }
        finally {
            release.resolve();
            await runtime.dispose();
        }
    });

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
                lane: 'durable',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        const message = createDequeuedMessage('dequeue-admits');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        await outbox.enqueueIfAbsent(queued);

        await runtime.ready();
        await waitForSettledOutboundWork(stores.workQueue, stores.admissionStore.namespace, new Set([DEQUEUE_TYPE]));

        expect(sent.map((prepared) => prepared.msgId)).toEqual([message.id.msgId]);
        expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.COMPLETED);
    });

    it('finishes grouped claims when the optional timing sink throws', async () => {
        const outbox = createOutboxQueue();
        const messages = ['timing-sink-throws-1', 'timing-sink-throws-2'].map(createDequeuedMessage);
        const entries = messages.map((message) => QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant()));
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: () => {
                throw new Error('timing sink failed');
            },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared.msgId);
                return { status: 'sent', submissionAttempted: true };
            }
        });

        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            await runOutboundWorkTask(runtime);
            expect(sent).toEqual(messages.map((message) => message.id.msgId));
            for (const entry of entries) {
                expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
            }
        }
        finally {
            await runtime.dispose();
        }
    });

    it('ends a rejected authority read without reporting a commit or ordered dispatch', async () => {
        const outbox = createOutboxQueue();
        const message = createDequeuedMessage('authority-read-fails');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: captureDequeueTiming(timings),
            readDequeueAuthority: async () => {
                throw new Error('authority unavailable');
            },
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent(queued);
            await runOutboundWorkTask(runtime);
            expect(timings.filter((event) => event.stage === 'authority-read-end'))
                .toEqual([expect.objectContaining({ outcome: 'error' })]);
            expect(timings.filter((event) => event.stage === 'admission-end'))
                .toEqual([expect.objectContaining({ outcome: 'error' })]);
            expect(timings.some((event) => event.stage === 'admission-commit-start' || event.stage === 'ordered-dispatch-start')).toBe(false);
        }
        finally {
            await runtime.dispose();
        }
    });

    it.each(['not-yet-in-sync', 'unauthorized', 'planner-drop'] as const satisfies readonly ALOutboundDropReasonCode[])(
        'completes a %s dequeue without publishing the row',
        async (dropReasonCode) => {
            const outbox = createOutboxQueue();
            const published: string[] = [];
            const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
            const runtime = createDefaultOutboundTestRuntime({
                outbox,
                dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
                dequeueTiming: captureDequeueTiming(timings),
                planOutgoingMessage: (msg) => ({
                    msg,
                    dropReason: 'Dropped before a route exists',
                    dropReasonCode,
                    lane: 'volatile',
                    preparedMessages: []
                }),
                afterDequeueAdmission: async (msg) => {
                    published.push(msg.id.msgId);
                },
                sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
            });
            const message = createDequeuedMessage(`discarded-${dropReasonCode}`);
            const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
            await outbox.enqueueIfAbsent(queued);

            await runtime.ready();

            expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.COMPLETED);
            expect(published).toEqual([]);
            expect(timings.filter((event) => event.stage === 'attempt-settled')).toEqual([
                expect.objectContaining({ key: queued.key, outcome: 'completed', verdict: expect.any(String) })
            ]);
            if (dropReasonCode === 'unauthorized') {
                expect(timings.find((event) => event.stage === 'attempt-settled')).toMatchObject({
                    verdict: 'refused',
                    reason: 'unauthorized'
                });
            }
        }
    );

    it('settles a grouped cancelled and expired claim before admission with distinct identity-only reasons', async () => {
        let nowMs = Date.now();
        const outbox = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs));
        const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            nowMs: () => nowMs,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: captureDequeueTiming(timings),
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const cancelled = createDequeuedMessage('cancelled-before-admission');
        const expiring = createDequeuedMessage('expired-before-admission');
        const entries = [cancelled, expiring].map((message) =>
            QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Instant.fromEpochMilliseconds(nowMs))
        );
        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            runtime.cancel(cancelled.id.msgId);
            const reserveEntries = outbox.reserveEntries.bind(outbox);
            vi.spyOn(outbox, 'reserveEntries').mockImplementation(async (input) => {
                const reserved = await reserveEntries(input);
                nowMs += 31_000;
                return reserved;
            });
            await runOutboundWorkTask(runtime);
            expect(timings.filter((event) => event.stage === 'reservation-return')).toHaveLength(2);
            expect(timings.filter((event) => event.stage === 'admission-start')).toHaveLength(0);
            expect(timings.filter((event) => event.stage === 'attempt-settled')).toEqual([
                expect.objectContaining({ key: entries[0]!.key, outcome: 'completed', reason: 'cancelled' }),
                expect.objectContaining({ key: entries[1]!.key, outcome: 'completed', reason: 'expired' })
            ]);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('settles a singleton cancelled claim before admission', async () => {
        const outbox = createOutboxQueue();
        const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: captureDequeueTiming(timings),
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createDequeuedMessage('single-cancelled');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent(queued);
            runtime.cancel(message.id.msgId);
            await runOutboundWorkTask(runtime);
            expect(timings.filter((event) => event.stage === 'admission-start')).toHaveLength(0);
            expect(timings.filter((event) => event.stage === 'attempt-settled')).toEqual([
                expect.objectContaining({ key: queued.key, outcome: 'completed', reason: 'cancelled', batchIndex: 0 })
            ]);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('settles a malformed singleton claim as a decode failure without admission', async () => {
        const outbox = createOutboxQueue();
        const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: captureDequeueTiming(timings),
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createDequeuedMessage('decode-failed');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent({ ...queued, resource: '{malformed' });
            await runOutboundWorkTask(runtime);
            expect(timings.filter((event) => event.stage === 'admission-start')).toHaveLength(0);
            expect(timings.filter((event) => event.stage === 'attempt-settled')).toEqual([
                expect.objectContaining({ key: queued.key, outcome: 'error', reason: 'decode-failed' })
            ]);
        }
        finally {
            await runtime.dispose();
        }
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
                    ? { msg, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [] }
                    : {
                        msg: { ...msg, id: { ...msg.id, senderId: 'other-sender' } },
                        dropReasonCode: undefined,
                        lane: 'volatile',
                        preparedMessages: []
                    },
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });
        const noRoute = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('no-route'), DEQUEUE_TYPE, Temporal.Now.instant());
        const failed = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('failed'), DEQUEUE_TYPE, Temporal.Now.instant());
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
        const timings: ALOutboundDequeuedAdmission.TimingEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: captureDequeueTiming(timings),
            // The RTC origin that owns no child re-plans a queued send to no-route (R-S2c-ii-9a).
            planOutgoingMessage: (msg) => ({
                msg,
                dropReason: 'No outbound transport route',
                dropReasonCode: 'no-route',
                lane: 'volatile',
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
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(stranded, DEQUEUE_TYPE, Temporal.Now.instant());
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
        const reservations = timings.filter((event) => event.stage === 'reservation-return');
        expect(reservations.map((event) => event.attempts)).toEqual(
            Array.from({ length: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts }, (_, index) => index + 1)
        );
        expect(reservations.every((event) =>
            event.key.topicId === queued.key.topicId &&
            event.key.resourceId === queued.key.resourceId &&
            event.key.contextId === queued.key.contextId
        )).toBe(true);
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
                lane: 'volatile',
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });
        for (const resourceId of ['charged-1', 'charged-2', 'charged-3']) {
            await outbox.enqueueIfAbsent(
                QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(resourceId), DEQUEUE_TYPE, Temporal.Now.instant())
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
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });
        await runtime.ready();
        for (let charge = 0; charge < 3; charge += 1) {
            resilience.failure();
        }
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('gated'), DEQUEUE_TYPE, Temporal.Now.instant());
        await outbox.enqueueIfAbsent(queued);

        await drainEngine(queueEngine);
        expect((await outbox.getItem(queued.key))?.status).toBe(EntityStatus.NEW);

        await expect.poll(async () => {
            await drainEngine(queueEngine);
            return (await outbox.getItem(queued.key))?.status;
        }).not.toBe(EntityStatus.NEW);
    });

    it('reads the authority and supersedence of a full dequeued page in one turn', async () => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        const authorityReads = createTurnRecorder();
        const supersedenceReads = createTurnRecorder();
        recordSupersedenceReads(stores.admissionStore, supersedenceReads);
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            readDequeueAuthority: async () => {
                authorityReads.record();
                return undefined;
            },
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const entries = Array.from(
            { length: AL_OUTBOUND_WORK_PAGE_SIZE },
            (_, index) => QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(`page-${index}`), DEQUEUE_TYPE, Temporal.Now.instant())
        );

        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            await runOutboundWorkTask(runtime);

            for (const entry of entries) {
                expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
            }
            // Two rows at a time took eight turns for the authority and eight more for the supersedence.
            expect(authorityReads.reads()).toBe(AL_OUTBOUND_WORK_PAGE_SIZE);
            expect(authorityReads.turns()).toBe(1);
            expect(supersedenceReads.turns()).toBe(1);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('fails a corrupt row of a dequeued group alone and charges the breaker once for it', async () => {
        const outbox = createOutboxQueue();
        const resilience = createDequeueResilience();
        const failures = vi.spyOn(resilience, 'failure');
        const successes = vi.spyOn(resilience, 'success');
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience },
            readDequeueAuthority: async (msg, entry) => {
                if (msg.route.resourceId === 'corrupt') {
                    throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), new TypeError('corrupt row'));
                }
                return undefined;
            },
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const entries = ['healthy-1', 'corrupt', 'healthy-2', 'healthy-3'].map((resourceId) =>
            QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(resourceId), DEQUEUE_TYPE, Temporal.Now.instant())
        );

        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            await runOutboundWorkTask(runtime);

            expect(await Promise.all(entries.map(async (entry) => (await outbox.getItem(entry.key))?.status))).toEqual([
                EntityStatus.COMPLETED,
                EntityStatus.NON_RETRYABLE,
                EntityStatus.COMPLETED,
                EntityStatus.COMPLETED
            ]);
            expect(failures).toHaveBeenCalledTimes(1);
            expect(successes).toHaveBeenCalledTimes(3);
        }
        finally {
            await runtime.dispose();
        }
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

it('separates held claim and execution from reservation logging in one completed batch', async () => {
    const outbox = createOutboxQueue();
    const events: RallarTimingEvent[] = [];
    let nowMs = Date.now();
    const claimEntered = Promise.withResolvers<void>();
    const claimRelease = Promise.withResolvers<void>();
    const runEntered = Promise.withResolvers<void>();
    const runRelease = Promise.withResolvers<void>();
    const timing = createRallarALOutboundDequeueTiming({ timing: (event) => events.push(event), serviceId: 'api', publisherId: 'publisher' });
    const runtime = createDefaultOutboundTestRuntime({
        outbox,
        nowMs: () => nowMs,
        dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
        dequeueTiming: (observation) => {
            timing(observation);
            if (observation.kind === 'reservation-returns') {
                nowMs += 19;
            }
        },
        readDequeueAuthority: async () => {
            runEntered.resolve();
            await runRelease.promise;
            return undefined;
        },
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    onTestFinished(async () => {
        claimRelease.resolve();
        runRelease.resolve();
        await runtime.dispose();
        vi.restoreAllMocks();
    });
    await runtime.ready();
    events.length = 0;
    const claim = outbox.reserveEntries.bind(outbox);
    vi.spyOn(outbox, 'reserveEntries').mockImplementation(async (...args) => {
        claimEntered.resolve();
        await claimRelease.promise;
        return await claim(...args);
    });
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage('batch-cost'), DEQUEUE_TYPE, Temporal.Now.instant());
    await outbox.enqueueIfAbsent(entry);
    const batchStartedAtMs = nowMs;
    const work = runOutboundWorkTask(runtime);
    await claimEntered.promise;
    nowMs += 31;
    claimRelease.resolve();
    await runEntered.promise;
    expect(events.some((event) => event.operation === 'work-batch')).toBe(false);
    nowMs += 47;
    runRelease.resolve();
    await work;
    const batches = events.filter((event) => event.operation === 'work-batch' && event.details?.claimedCount === 1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
        durationMs: 97,
        details: {
            lane: 'durable',
            batchStartedAtMs,
            runStartedAtMs: batchStartedAtMs + 50,
            selectionDurationMs: 0,
            claimDurationMs: 31,
            runDurationMs: 47,
            releaseDurationMs: 0,
            queueWaitMs: 0,
            claimedCount: 1,
            completedCount: 1,
            rescheduledCount: 0,
            rejectedCount: 0
        }
    });
    expect(events.find((event) => event.operation === 'reservation-return')?.details).toMatchObject({
        ...entry.key,
        batchStartedAtMs,
        workerId: batches[0]?.details?.workerId,
        lane: 'durable'
    });
    expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
});

it.each(['committed', 'conflict', 'error', 'decision-error'] as const)(
    'observes one held group decision and bundle window before %s resolution',
    async (outcome) => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        const events: RallarTimingEvent[] = [];
        let nowMs = Date.now();
        const readEntered = Promise.withResolvers<void>();
        const readRelease = Promise.withResolvers<void>();
        const transactionEntered = Promise.withResolvers<void>();
        const transactionRelease = Promise.withResolvers<void>();
        const read = stores.admissionStore.readOutgoingMessage.bind(stores.admissionStore);
        vi.spyOn(stores.admissionStore, 'readOutgoingMessage').mockImplementation(async (input) => {
            readEntered.resolve();
            await readRelease.promise;
            if (outcome === 'decision-error') {
                throw new Error('group decision read failed');
            }
            return await read(input);
        });
        const write = stores.backend.write.bind(stores.backend);
        vi.spyOn(stores.backend, 'write').mockImplementationOnce(async (operation, deadline) => {
            transactionEntered.resolve();
            await transactionRelease.promise;
            if (outcome === 'error') {
                throw new Error('held bundle failed');
            }
            return await write(operation, deadline);
        });
        if (outcome === 'conflict') {
            vi.spyOn(stores.admissionStore, 'commitBundles').mockImplementationOnce(async () => {
                transactionEntered.resolve();
                await transactionRelease.promise;
                return 'conflict';
            });
        }
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            nowMs: () => nowMs,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: createRallarALOutboundDequeueTiming({ timing: (event) => events.push(event), serviceId: 'api', publisherId: 'publisher' }),
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            afterDequeueAdmission: async (msg) => {
                sent.push(msg.id.msgId);
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        onTestFinished(async () => {
            readRelease.resolve();
            transactionRelease.resolve();
            await runtime.dispose();
            vi.restoreAllMocks();
        });
        await runtime.ready();
        const messages = ['group-first', 'group-second'].map(createDequeuedMessage);
        const entries = messages.map((message) => QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant()));
        for (const entry of entries) {
            await outbox.enqueueIfAbsent(entry);
        }
        const work = runOutboundWorkTask(runtime);
        await readEntered.promise;
        nowMs += 23;
        readRelease.resolve();
        if (outcome !== 'decision-error') {
            await transactionEntered.promise;
        }
        expect(events.some((event) => event.operation === 'admission-group')).toBe(false);
        expect(sent).toEqual([]);
        if (outcome !== 'decision-error') {
            nowMs += 41;
        }
        transactionRelease.resolve();
        await work;
        const groups = events.filter((event) => event.operation === 'admission-group');
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            durationMs: outcome === 'decision-error' ? 23 : 64,
            status: outcome === 'error' || outcome === 'decision-error' ? 'error' : 'ok',
            details: {
                ...entries[0]!.key,
                memberCount: 2,
                decisionDurationMs: 23,
                bundleDurationMs: outcome === 'decision-error' ? 0 : 41,
                outcome: outcome === 'decision-error' ? 'error' : outcome
            }
        });
        expect(sent).toEqual(messages.map((message) => message.id.msgId));
        expect(events.filter((event) => event.operation === 'work-batch' && event.details?.claimedCount === 2)).toHaveLength(1);
        for (const entry of entries) {
            expect((await outbox.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        }
    }
);

it('keeps simultaneous owner reservations separate and reports an empty claim without inventing a completed failed claim', async () => {
    const events: RallarTimingEvent[] = [];
    const nowMs = Date.now();
    const release = Promise.withResolvers<void>();
    const owners = ['owner-one', 'owner-two'].map((name) => {
        const outbox = createOutboxQueue();
        const entered = Promise.withResolvers<void>();
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            nowMs: () => nowMs,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            dequeueTiming: createRallarALOutboundDequeueTiming({ timing: (event) => events.push(event), serviceId: 'api', publisherId: 'publisher' }),
            readDequeueAuthority: async () => {
                entered.resolve();
                await release.promise;
                return undefined;
            },
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(name), DEQUEUE_TYPE, Temporal.Now.instant());
        return { outbox, runtime, entered, entry };
    });
    onTestFinished(async () => {
        release.resolve();
        await Promise.all(owners.map((owner) => owner.runtime.dispose()));
        vi.restoreAllMocks();
    });
    await Promise.all(owners.map((owner) => owner.runtime.ready()));
    expect(events.filter((event) => event.operation === 'work-batch')).toHaveLength(2);
    for (const event of events.filter((event) => event.operation === 'work-batch')) {
        expect(event).toMatchObject({ durationMs: 0, details: { claimedCount: 0, completedCount: 0, queueWaitMs: 0 } });
    }
    events.length = 0;
    await Promise.all(owners.map((owner) => owner.outbox.enqueueIfAbsent(owner.entry)));
    const work = owners.map((owner) => runOutboundWorkTask(owner.runtime));
    await Promise.all(owners.map((owner) => owner.entered.promise));
    const reservations = events.filter((event) => event.operation === 'reservation-return');
    expect(reservations).toHaveLength(2);
    expect(new Set(reservations.map((event) => event.details?.workerId)).size).toBe(2);
    release.resolve();
    await Promise.all(work);
    for (const reservation of reservations) {
        const batches = events.filter((event) =>
            event.operation === 'work-batch' && event.details?.claimedCount === 1 &&
            event.serviceId === reservation.serviceId && event.details?.publisherId === reservation.details?.publisherId &&
            event.details?.lane === reservation.details?.lane && event.details?.workerId === reservation.details?.workerId &&
            event.details?.batchStartedAtMs === reservation.details?.batchStartedAtMs
        );
        expect(batches).toHaveLength(1);
    }
    const owner = owners[0]!;
    events.length = 0;
    vi.spyOn(owner.outbox, 'reserveEntries').mockRejectedValueOnce(new Error('claim unavailable'));
    await runOutboundWorkTask(owner.runtime);
    expect(events.filter((event) => event.operation === 'work-batch')).toEqual([]);
    await runOutboundWorkTask(owner.runtime);
    expect(events.filter((event) => event.operation === 'work-batch')).toHaveLength(1);
});

interface TurnRecorder {
    record(): void;
    reads(): number;
    turns(): number;
}

/** Counts reads and the synchronous turns they were issued in, as a turn-batched backend would group them. */
function createTurnRecorder(): TurnRecorder {
    let reads = 0;
    let turns = 0;
    let open = false;
    return {
        record: () => {
            reads += 1;
            if (!open) {
                open = true;
                turns += 1;
                queueMicrotask(() => {
                    open = false;
                });
            }
        },
        reads: () => reads,
        turns: () => turns
    };
}

/** Records the turn of every supersedence read, of one message or of a group. */
function recordSupersedenceReads(store: ALOutboundAdmissionStore<OutboundTestPayload>, recorder: TurnRecorder): void {
    const isMessageSuperseded = store.isMessageSuperseded.bind(store);
    const readMessageSupersedence = store.readMessageSupersedence.bind(store);
    vi.spyOn(store, 'isMessageSuperseded').mockImplementation((msg) => {
        recorder.record();
        return isMessageSuperseded(msg);
    });
    vi.spyOn(store, 'readMessageSupersedence').mockImplementation((messages) => {
        recorder.record();
        return readMessageSupersedence(messages);
    });
}
