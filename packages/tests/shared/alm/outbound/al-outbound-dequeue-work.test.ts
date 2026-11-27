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
import { newALReceiptControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { decodeALAdmissionClientRecord, decodeALOutboundMessageVersion } from '@shared/alm/al-admission-value-validation.ts';
import {
    toALOutboundOriginMessageKey,
    toALOutboundSentMessageKey,
    toALOutboundVersionKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { ALOutboundMessageRuntime, type ALOutboundDropReasonCode } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_OUTBOUND_WORK_PAGE_SIZE,
    computeALOutboundWorkEntry
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALOutboundDequeuedAdmission } from '@shared/alm/outbound/lane/al-outbound-dequeued-admission.ts';
import {
    createALOutboundReceiptWorkEvidence,
    type ALOutboundReceiptWorkObservation
} from '@shared/alm/outbound/lane/al-outbound-receipt-observation.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import {
    EntityStatus,
    InMemoryQueueBox,
    newALUnicastMessage,
    QueueBoxUtilities,
    type ALMessage,
    type ResourceEntry
} from '@shared/mod.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { waitForSettledOutboundWork } from '../../wait-for-al-outbound-work.ts';
import {
    commitCompetingOutboundMessageCommit,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    drainEngine,
    peekOutboundWorkReadyAt,
    readOutboundTestAdmission,
    runOutboundWorkTask,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const DEQUEUE_TYPE = 'WS_OUTBOX';

function captureDequeueTiming(
    events: ALOutboundDequeuedAdmission.TimingEvent[]
): ALOutboundDequeuedAdmission.TimingSink {
    return (observation) => events.push(...toALOutboundDequeueTimingEvents(observation));
}

function createDequeueResilience(maxConsecutiveFailures = 10, openMs = 500): ResourceInboxResilience {
    const open = Temporal.Duration.from({ milliseconds: openMs });
    const window = Temporal.Duration.from({ milliseconds: 500 });
    return ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(maxConsecutiveFailures, open, open, window));
}

function createOutboxQueue(): InMemoryQueueBox {
    return new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()));
}

function createDequeuedMessage(resourceId: string): ALMessage {
    return newALUnicastMessage(
        {
            createdAtEpochMs: Date.now(),
            senderId: 'server',
            route: { topicId: 'chat', resourceId, contextId: 'conversation-1' },
            toPeerId: 'peer-1',
            typeId: 'chat.private-text.v1',
            resource: { text: resourceId },
            options: { ttlMs: 30_000 }
        }
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
            runtime.cancel(cancelled.id.msgId, cancelled.id.traceId);
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createDequeuedMessage('single-cancelled');
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent(queued);
            runtime.cancel(message.id.msgId, message.id.traceId);
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
            {
                createdAtEpochMs: Date.now(),
                senderId: 'server',
                route: { topicId: 'chat', resourceId: 'stranded', contextId: 'conversation-1' },
                toPeerId: 'peer-1',
                typeId: 'chat.private-text.v1',
                resource: { text: 'stranded' },
                options: { ttlMs: 3_600_000 }
            }
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
        const charges = recordBreakerCharges(resilience);
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience },
            readDequeueAuthority: async (msg, entry) => {
                if (msg.route.resourceId === 'corrupt') {
                    throw new ALAdmissionCorruptionError(JSON.stringify(entry.key), new TypeError('corrupt row'));
                }
                return undefined;
            },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
            expect(charges).toEqual(['success', 'failure', 'success', 'success']);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('hands each committed row of a group the policy its commit wrote, in row order', async () => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        const handed: HandedDequeuePolicy[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [],
                admittedAudience: ['peer-1'],
                recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
            }),
            afterDequeueAdmission: async (msg, entry, admission) => {
                handed.push({ msgId: msg.id.msgId, entry, committedPolicy: admission.committedPolicy });
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const messages = ['ordered-1', 'ordered-2', 'ordered-3'].map(createDequeuedMessage);

        try {
            await runtime.ready();
            for (const message of messages) {
                await outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant()));
            }
            await runOutboundWorkTask(runtime);

            expect(handed.map(({ msgId }) => msgId)).toEqual(messages.map((message) => message.id.msgId));
            for (const [index, { entry, committedPolicy }] of handed.entries()) {
                expect(committedPolicy).toMatchObject({ admittedAudience: ['peer-1'] });
                expect(committedPolicy).toEqual(await stores.admissionStore.readCapturedPolicy(messages[index]!, entry));
            }
        }
        finally {
            await runtime.dispose();
        }
    });

    it('hands after-admission the authority its dequeue read planned from', async () => {
        const outbox = createOutboxQueue();
        const handed: (readonly string[] | undefined)[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            readDequeueAuthority: async () => ({
                admittedAudience: ['b'],
                audienceJudged: true,
                recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
            }),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [],
                admittedAudience: ['b', 'c'],
                recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
            }),
            afterDequeueAdmission: async (_msg, _entry, admission) => {
                handed.push(admission.dequeueAuthority?.admittedAudience);
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createDequeuedMessage('authority-handed');

        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant()));
            await runOutboundWorkTask(runtime);

            expect(handed).toEqual([['b']]);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('hands after-admission no authority when the stored row is not the row its dequeue read the authority for', async () => {
        const outbox = createOutboxQueue();
        const handed: { readonly resourceId: string; readonly judged: readonly string[] | undefined; }[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            readDequeueAuthority: async () => ({
                admittedAudience: ['b'],
                audienceJudged: true,
                recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
            }),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [],
                admittedAudience: ['b', 'c'],
                recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
            }),
            afterDequeueAdmission: async (_msg, entry, admission) => {
                handed.push({ resourceId: entry.key.resourceId, judged: admission.dequeueAuthority?.admittedAudience });
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createDequeuedMessage('authority-won');
        const won = QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant());
        const raced = { ...won, key: { ...won.key, resourceId: 'authority-raced' } };

        try {
            await runtime.ready();
            await outbox.enqueueIfAbsent(won);
            await runOutboundWorkTask(runtime);
            await outbox.enqueueIfAbsent(raced);
            await runOutboundWorkTask(runtime);
            console.log('handed after-admission', JSON.stringify(handed));

            expect(handed).toEqual([
                { resourceId: 'authority-won', judged: ['b'] },
                { resourceId: 'authority-won', judged: undefined }
            ]);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('hands nothing to the publication of a row whose commit conflicted', async () => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        vi.spyOn(stores.admissionStore, 'commitBundles').mockResolvedValue('conflict');
        vi.spyOn(stores.admissionStore, 'commitBundle').mockResolvedValue('conflict');
        const handed: HandedDequeuePolicy[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
            afterDequeueAdmission: async (msg, entry, admission) => {
                handed.push({ msgId: msg.id.msgId, entry, committedPolicy: admission.committedPolicy });
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const entries = ['conflicted-1', 'conflicted-2'].map((resourceId) =>
            QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(resourceId), DEQUEUE_TYPE, Temporal.Now.instant())
        );
        onTestFinished(() => {
            vi.restoreAllMocks();
        });

        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            await runOutboundWorkTask(runtime);

            expect(handed).toEqual([]);
            for (const entry of entries) {
                expect((await outbox.getItem(entry.key))?.status).not.toBe(EntityStatus.COMPLETED);
            }
        }
        finally {
            await runtime.dispose();
        }
    });

    it.each(
        [
            { authority: 'readable', label: 'a readable authority' },
            { authority: 'unavailable', label: 'an unavailable authority' }
        ] as const
    )('fails only the row whose supersedence is corrupt in the group read, behind $label', async ({ authority }) => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        const resilience = createDequeueResilience();
        const charges = recordBreakerCharges(resilience);
        const messages = ['healthy-1', 'corrupt', 'healthy-2', 'healthy-3'].map(createDequeuedMessage);
        await writeCorruptSentMessage(stores, messages[1]!.id.msgId);
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience },
            readDequeueAuthority: async (msg) => {
                if (authority === 'unavailable' && msg.route.resourceId === 'corrupt') {
                    throw new Error('authority unavailable');
                }
                return undefined;
            },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const entries = messages.map((message) => QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant()));

        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            await runOutboundWorkTask(runtime);

            // Corruption decides first: the authority failure alone would have retried the row.
            expect(await Promise.all(entries.map(async (entry) => (await outbox.getItem(entry.key))?.status))).toEqual([
                EntityStatus.COMPLETED,
                EntityStatus.NON_RETRYABLE,
                EntityStatus.COMPLETED,
                EntityStatus.COMPLETED
            ]);
            expect(charges).toEqual(['success', 'failure', 'success', 'success']);
        }
        finally {
            await runtime.dispose();
        }
    });

    it('commits a dequeued batch that holds receipt controls and a sequenced row of one sender in two writes', async () => {
        // Pins a mixed batch refused as one group and committing its members alone, one after another.
        const batch = await createMixedFenceBatch();
        onTestFinished(async () => await batch.runtime.dispose());

        await runDequeuedFenceBatch(batch);

        for (const message of batch.messages) {
            expect(await batch.stores.admissionStore.readStoredMessage(message.id.msgId), message.id.msgId).toBeDefined();
            expect(await readMixedBatchMessageVersion(batch.stores, message), message.id.msgId).toBe(1);
        }
        expect(await readDequeuedFenceBatchSenderVersion(batch.stores)).toBe(1);
        expectEachRowDispatchedAndSentOnce(batch);
        expect(toDequeuedFenceBatchGroupOutcomes(batch)).toEqual(expect.arrayContaining([
            { memberCount: 1, outcome: 'committed' },
            { memberCount: 3, outcome: 'committed' }
        ]));
        expect(batch.groups).toHaveLength(2);
        for (const entry of batch.entries) {
            expect((await batch.outbox.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        }
    });

    it('when the sequenced row of a mixed batch loses its fence, the receipts\' write stands and is not committed again', async () => {
        // Pins a mixed batch whose lost sender fence fails the receipts' write too, so each receipt commits a second
        // time and its message version moves twice. A second commit names the same send effects, so the transport sends
        // one copy of each either way: the sends below show the batch ran, not this defect.
        const batch = await createMixedFenceBatch();
        onTestFinished(async () => await batch.runtime.dispose());
        const commitBundles = batch.stores.admissionStore.commitBundles.bind(batch.stores.admissionStore);
        let interleaved = false;
        vi.spyOn(batch.stores.admissionStore, 'commitBundles').mockImplementation(async (bundles) => {
            if (!interleaved && bundles.some((bundle) => bundle.fencesSender)) {
                interleaved = true;
                // Another frame of the sender, on a track of its own, commits after the group read the sender version.
                const frame = await readOutboundTestAdmission({
                    store: batch.stores.admissionStore,
                    message: { ...createDequeuedMessage('interleaved'), ordering: { orderingKey: 'interleaved-feed', epoch: 1, seq: 1 } },
                    creationNow: () => Temporal.Now.instant(),
                    clock: { nowMs: () => Date.now() }
                });
                expect(await commitBundles([frame])).toBe('committed');
            }
            return await commitBundles(bundles);
        });

        await runDequeuedFenceBatch(batch);

        expect(toDequeuedFenceBatchGroupOutcomes(batch)).toEqual(expect.arrayContaining([
            { memberCount: 1, outcome: 'conflict' },
            { memberCount: 3, outcome: 'committed' }
        ]));
        expect(batch.groups).toHaveLength(2);
        // Each row's message version moved once: the receipts' write committed them, and nothing committed them again.
        for (const message of batch.messages) {
            expect(await readMixedBatchMessageVersion(batch.stores, message), message.id.msgId).toBe(1);
        }
        expectEachRowDispatchedAndSentOnce(batch);
        // The interleaved frame's commit and the sequenced row's own single commit after it.
        expect(await readDequeuedFenceBatchSenderVersion(batch.stores)).toBe(2);
    });

    it('when a receipt of a mixed batch loses its own fence, the sequenced row\'s write stands and only the receipts commit alone', async () => {
        // Pins a lost message fence of the receipts' write sending the committed sequenced row to commit again, or
        // handing a row the commit of another.
        const batch = await createMixedFenceBatch();
        onTestFinished(async () => await batch.runtime.dispose());
        const commitBundles = batch.stores.admissionStore.commitBundles.bind(batch.stores.admissionStore);
        let interleaved = false;
        vi.spyOn(batch.stores.admissionStore, 'commitBundles').mockImplementation(async (bundles) => {
            const [losing] = bundles;
            if (!interleaved && losing !== undefined && !losing.fencesSender && bundles.length > 1) {
                interleaved = true;
                // Another commit of the first receipt's own message lands after the group read its version.
                await commitCompetingOutboundMessageCommit<OutboundTestPayload>(async (bundle) => await commitBundles([bundle]), losing);
            }
            return await commitBundles(bundles);
        });

        await runDequeuedFenceBatch(batch);

        expect(toDequeuedFenceBatchGroupOutcomes(batch)).toEqual(expect.arrayContaining([
            { memberCount: 1, outcome: 'committed' },
            { memberCount: 3, outcome: 'conflict' }
        ]));
        expect(batch.groups).toHaveLength(2);
        // The competitor and the receipt's own commit alone; every other row moved its version once.
        const versions = await Promise.all(batch.messages.map((message) => readMixedBatchMessageVersion(batch.stores, message)));
        expect(versions).toEqual([2, 1, 1, 1]);
        expect(await readDequeuedFenceBatchSenderVersion(batch.stores)).toBe(1);
        expectEachRowDispatchedAndSentOnce(batch);
    });

    it('when the receipts\' write of a mixed batch throws, the sequenced row\'s write stands and only the receipts commit alone', async () => {
        // Pins a throw of one part's write sending every member of the group, the committed part's too, to commit alone.
        const batch = await createMixedFenceBatch();
        onTestFinished(async () => await batch.runtime.dispose());
        const commitBundles = batch.stores.admissionStore.commitBundles.bind(batch.stores.admissionStore);
        let thrown = false;
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(batch.stores.admissionStore, 'commitBundles').mockImplementation((bundles) => {
            if (!thrown && bundles.length > 1 && bundles.every((bundle) => !bundle.fencesSender)) {
                thrown = true;
                throw new Error('receipts write failed');
            }
            return commitBundles(bundles);
        });

        await runDequeuedFenceBatch(batch);

        for (const message of batch.messages) {
            expect(await readMixedBatchMessageVersion(batch.stores, message), message.id.msgId).toBe(1);
        }
        expect(toDequeuedFenceBatchGroupOutcomes(batch)).toEqual(expect.arrayContaining([
            { memberCount: 1, outcome: 'committed' },
            { memberCount: 3, outcome: 'error' }
        ]));
        expect(batch.groups).toHaveLength(2);
        expect(await readDequeuedFenceBatchSenderVersion(batch.stores)).toBe(1);
        expectEachRowDispatchedAndSentOnce(batch);
    });

    it('when the sequenced rows of a mixed batch read different sender versions, the receipts still commit as one write', async () => {
        // Pins a disagreement among the sender-fenced reads sending the receipts, which fence no sender, to commit alone
        // too.
        const receipts = ['1', '2'].map((index) => createDequeuedReceipt(`receipt-${index}`, `subject-${index}`));
        const [first, second] = ['a', 'b'].map((track): ALMessage => ({
            ...createDequeuedMessage(`sequenced-${track}`),
            ordering: { orderingKey: `feed-${track}`, epoch: 1, seq: 1 }
        }));
        const batch = await createDequeuedFenceBatch([receipts[0]!, first!, receipts[1]!, second!]);
        onTestFinished(async () => await batch.runtime.dispose());
        const store = batch.stores.admissionStore;
        const readOutgoingMessage = store.readOutgoingMessage.bind(store);
        const interleaved = Promise.withResolvers<void>();
        vi.spyOn(store, 'readOutgoingMessage').mockImplementation(async (input) => {
            if (input.msg.id.msgId === second!.id.msgId) {
                await interleaved.promise;
            }
            const read = await readOutgoingMessage(input);
            if (input.msg.id.msgId === first!.id.msgId) {
                // Another frame of the sender, on a track of its own, commits between the two sequenced rows' reads.
                const frame = await readOutboundTestAdmission({
                    store,
                    message: { ...createDequeuedMessage('interleaved'), ordering: { orderingKey: 'interleaved-feed', epoch: 1, seq: 1 } },
                    creationNow: () => Temporal.Now.instant(),
                    clock: { nowMs: () => Date.now() }
                });
                expect(await store.commitBundles([frame])).toBe('committed');
                interleaved.resolve();
            }
            return read;
        });

        await runDequeuedFenceBatch(batch);

        expect(toDequeuedFenceBatchGroupOutcomes(batch)).toEqual([{ memberCount: 2, outcome: 'committed' }]);
        for (const message of batch.messages) {
            expect(await readMixedBatchMessageVersion(batch.stores, message), message.id.msgId).toBe(1);
        }
        // The interleaved frame's commit, then each sequenced row's own commit alone.
        expect(await readDequeuedFenceBatchSenderVersion(batch.stores)).toBe(3);
        expectEachRowDispatchedAndSentOnce(batch);
    });

    it('fences the sender for a follower dequeued in one batch with its predecessor', async () => {
        // Pins a follower's decision leaving the sender fence: a follower holds a place on its predecessor's track, so
        // it joins its predecessor's fence group, and their one write moves the sender version once. A follower that
        // fenced no sender either writes its tracked row outside the sender fence, which the store refuses and the group
        // reads `error`, or commits in a group of its own.
        const batch = await createDequeuedFenceBatch([1, 2].map((seq) => ({
            ...createDequeuedMessage(`track-${seq}`),
            ordering: { orderingKey: 'feed', epoch: 1, seq }
        })));
        onTestFinished(async () => await batch.runtime.dispose());

        await runDequeuedFenceBatch(batch);

        expect(batch.groups).toHaveLength(1);
        expect(toDequeuedFenceBatchGroupOutcomes(batch)).toEqual([{ memberCount: 2, outcome: 'committed' }]);
        expect(await readDequeuedFenceBatchSenderVersion(batch.stores)).toBe(1);
        expectEachRowDispatchedAndSentOnce(batch);
    });

    it('opens no supersedence session for a group whose every row the gate decided', async () => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        const resilience = createDequeueResilience(2);
        // After the claim the store is closed: a session opened for nothing would reject with no reader.
        const sessionsAfterClaim = recordSessionsAfter(stores, () => resilience.isNotAllowedThroughToDequeue());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience },
            // The breaker opens between the claim and the gate, so every front decides its row.
            dequeueTiming: (observation) => {
                if (observation.kind === 'reservation-returns') {
                    for (let charge = 0; charge < 3; charge += 1) {
                        resilience.failure();
                    }
                }
            },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const entries = ['gated-1', 'gated-2'].map((resourceId) =>
            QueueBoxUtilities.toResourceEntryFromMsg(createDequeuedMessage(resourceId), DEQUEUE_TYPE, Temporal.Now.instant())
        );

        try {
            await runtime.ready();
            for (const entry of entries) {
                await outbox.enqueueIfAbsent(entry);
            }
            await runOutboundWorkTask(runtime);

            expect(await Promise.all(entries.map(async (entry) => (await outbox.getItem(entry.key))?.status)))
                .not.toContain(EntityStatus.COMPLETED);
            expect(sessionsAfterClaim).toEqual([]);
        }
        finally {
            await runtime.dispose();
        }
    });

    it.each(
        [
            { failing: 'authority', stage: 'dequeue-authority' },
            { failing: 'supersedence', stage: 'dequeue-supersedence' }
        ] as const
    )('names the failed $failing read as the stage of a dequeued receipt', async ({ failing, stage }) => {
        const outbox = createOutboxQueue();
        const stores = createDefaultOutboundTestStores(outbox);
        const engine = new InboxOutboxEngine();
        const observations: ALOutboundReceiptWorkObservation[] = [];
        const receipt = createDequeuedReceipt();
        if (failing === 'supersedence') {
            await writeCorruptSentMessage(stores, receipt.id.msgId);
        }
        const plan = (msg: ALMessage) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'durable' as const,
            preparedMessages: []
        });
        const runtime = new ALOutboundMessageRuntime<OutboundTestPayload>({
            ...createDefaultALOutboundRuntimeResources({
                decodePrepared: decodeOutboundTestPayload,
                stores,
                canonicalQueue: outbox,
                queueEngine: engine
            }),
            carrier: 'ws',
            recipientAuthentication: { kind: 'carrier' },
            dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
            receiptWorkCapture: {
                batchObservations: ALWorkBatchObservations,
                createEvidence: createALOutboundReceiptWorkEvidence,
                observer: (observation) => observations.push(observation)
            },
            readDequeueAuthority: async () => {
                if (failing === 'authority') {
                    throw new Error('authority unavailable');
                }
                return undefined;
            },
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: plan,
            planDequeuedMessage: plan,
            decodePreparedMessage: decodeOutboundTestPayload,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true }),
            afterDequeueAdmission: undefined,
            planRepairMessage: undefined,
            diagnostics: undefined,
            settlements: undefined
        });
        onTestFinished(() => runtime.dispose());
        await outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(receipt, DEQUEUE_TYPE, Temporal.Now.instant()));

        await runtime.ready();

        await expect.poll(() => observations.length).toBe(1);
        expect(observations[0]).toMatchObject({ receiptControlMsgId: receipt.id.msgId, stage });
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: []
            }),
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

/** What one dequeued row handed its publication: the canonical row and the policy its commit wrote. */
interface HandedDequeuePolicy {
    readonly msgId: string;
    readonly entry: ResourceEntry;
    readonly committedPolicy: ALOutboundCapturedPolicy | undefined;
}

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

/** Records the turn of every group supersedence read. */
function recordSupersedenceReads(store: ALOutboundAdmissionStore<OutboundTestPayload>, recorder: TurnRecorder): void {
    const readMessageSupersedence = store.readMessageSupersedence.bind(store);
    vi.spyOn(store, 'readMessageSupersedence').mockImplementation((messages) => {
        recorder.record();
        return readMessageSupersedence(messages);
    });
}

/** Every read session the backend refuses once `closed` holds, as a closed store refuses it. */
function recordSessionsAfter(stores: OutboundTestStores, closed: () => boolean): readonly string[] {
    const sessions: string[] = [];
    const readWithin = stores.backend.readWithin.bind(stores.backend);
    vi.spyOn(stores.backend, 'readWithin').mockImplementation((read) => {
        if (!closed()) {
            return readWithin(read);
        }
        sessions.push('refused');
        return Promise.reject(new Error('store closed'));
    });
    return sessions;
}

/** Every breaker charge, in the order the rows' attempts made them. */
function recordBreakerCharges(resilience: ResourceInboxResilience): readonly string[] {
    const charges: string[] = [];
    const success = resilience.success.bind(resilience);
    const failure = resilience.failure.bind(resilience);
    vi.spyOn(resilience, 'success').mockImplementation(() => {
        charges.push('success');
        success();
    });
    vi.spyOn(resilience, 'failure').mockImplementation(() => {
        charges.push('failure');
        failure();
    });
    return charges;
}

/** A sent-message row that fails to decode, so every read of the message's admission is corrupt. */
async function writeCorruptSentMessage(stores: OutboundTestStores, msgId: string): Promise<void> {
    await stores.backend.write(async (tx) => {
        await tx.set(toALOutboundSentMessageKey(stores.admissionStore.namespace, msgId), 'corrupt', Date.now() + 60_000);
    });
}

/** One page of the server's outbox, dequeued as one batch. */
interface DequeuedFenceBatch {
    readonly outbox: InMemoryQueueBox;
    readonly stores: OutboundTestStores;
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly messages: readonly ALMessage[];
    readonly entries: readonly ResourceEntry[];
    /** The `admission-group` observations the batch's dequeue records. */
    readonly groups: readonly Extract<ALOutboundDequeuedAdmission.TimingObservation, { kind: 'admission-group'; }>[];
    /** Each copy the transport sent, by the message it carries, in send order. */
    readonly sent: readonly string[];
    /** Each claimed row's ordered dispatch: the row's key, beside the key of the row its commit answered with. */
    readonly dispatched: readonly Readonly<{ claimedKey: string; publicationKey: string; }>[];
}

/**
 * Three receipt controls and, among them, one frame on a track. Each receipt names its own subject: an outbox row is
 * keyed by the route, which a receipt addresses by its subject, so receipts of one subject would share one row and the
 * page would hold one of them.
 */
async function createMixedFenceBatch(): Promise<DequeuedFenceBatch> {
    const receipts = ['1', '2', '3'].map((index) => createDequeuedReceipt(`receipt-${index}`, `subject-${index}`));
    const sequenced: ALMessage = { ...createDequeuedMessage('sequenced'), ordering: { orderingKey: 'feed', epoch: 1, seq: 1 } };
    return await createDequeuedFenceBatch([receipts[0]!, sequenced, receipts[1]!, receipts[2]!]);
}

/** The messages enqueued on a ready runtime whose every plan sends one copy, their rows not yet claimed. */
async function createDequeuedFenceBatch(messages: readonly ALMessage[]): Promise<DequeuedFenceBatch> {
    const outbox = createOutboxQueue();
    const stores = createDefaultOutboundTestStores(outbox);
    const groups: Extract<ALOutboundDequeuedAdmission.TimingObservation, { kind: 'admission-group'; }>[] = [];
    const sent: string[] = [];
    const dispatched: { claimedKey: string; publicationKey: string; }[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        outbox,
        stores,
        dequeue: { types: new Set([DEQUEUE_TYPE]), resilience: createDequeueResilience() },
        dequeueTiming: (observation) => {
            if (observation.kind === 'admission-group') {
                groups.push(observation);
            }
            if (observation.kind === 'admission-stage' && observation.publicationKey !== undefined) {
                dispatched.push({
                    claimedKey: toKeyAsString(observation.member.effect.entry.key),
                    publicationKey: toKeyAsString(observation.publicationKey)
                });
            }
        },
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [{ peer: 'origin' }] }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    await runtime.ready();
    const entries = messages.map((message) => QueueBoxUtilities.toResourceEntryFromMsg(message, DEQUEUE_TYPE, Temporal.Now.instant()));
    for (const entry of entries) {
        await outbox.enqueueIfAbsent(entry);
    }
    return { outbox, stores, runtime, messages, entries, groups, sent, dispatched };
}

/** Runs the batch's dequeue, then the batch of sends its commits queued. */
async function runDequeuedFenceBatch(batch: DequeuedFenceBatch): Promise<void> {
    await runOutboundWorkTask(batch.runtime);
    await runOutboundWorkTask(batch.runtime);
}

/** The batch's `admission-group` observations as member count and outcome. */
function toDequeuedFenceBatchGroupOutcomes(batch: DequeuedFenceBatch): readonly Readonly<{ memberCount: number; outcome: string; }>[] {
    return batch.groups.map(({ memberCount, outcome }) => ({ memberCount, outcome }));
}

/** Every claimed row of the batch dispatched on its own commit's answer, and every message sent exactly once. */
function expectEachRowDispatchedAndSentOnce(batch: DequeuedFenceBatch): void {
    const claimedKeys = batch.entries.map((entry) => toKeyAsString(entry.key)).sort();
    expect(batch.dispatched.map(({ claimedKey }) => claimedKey).sort()).toEqual(claimedKeys);
    for (const { claimedKey, publicationKey } of batch.dispatched) {
        expect(publicationKey).toBe(claimedKey);
    }
    expect([...batch.sent].sort()).toEqual(batch.messages.map((message) => message.id.msgId).sort());
}

async function readDequeuedFenceBatchSenderVersion(stores: OutboundTestStores): Promise<number | undefined> {
    return await stores.backend.read(
        toALOutboundVersionKey(stores.admissionStore.namespace, 'server'),
        (value) => decodeALAdmissionClientRecord(value, 'server').version
    );
}

async function readMixedBatchMessageVersion(stores: OutboundTestStores, message: ALMessage): Promise<number | undefined> {
    const { senderId, msgId } = message.id;
    return await stores.backend.read(
        toALOutboundOriginMessageKey({ row: 'msg-version', namespace: stores.admissionStore.namespace, originPeerId: senderId, msgId }),
        (value) => decodeALOutboundMessageVersion(value, msgId).version
    );
}

/** The server's terminal receipt `msgId` of the message `subjectMsgId`. */
function createDequeuedReceipt(msgId = 'dequeued-receipt', subjectMsgId = 'subject'): ALMessage {
    return {
        ...newALReceiptControlMessage(
            { v: 4, msgId, senderId: 'server', ts: Date.now(), traceId: 'trace-al-outbound-dequeue-work' },
            {
                msgId: subjectMsgId,
                originPeerId: 'origin',
                phase: 'complete',
                expectedRecipientPeerIds: ['recipient'],
                confirmedRecipientPeerIds: ['recipient'],
                outsideAudienceRecipientPeerIds: [],
                snapshotVersion: 7,
                observedAtEpochMs: 1000
            }
        ),
        constraints: { expiresAtMs: Date.now() + 30_000 }
    };
}
