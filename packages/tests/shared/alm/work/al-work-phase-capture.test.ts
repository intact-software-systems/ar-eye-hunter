import { Temporal } from '@js-temporal/polyfill';
import {
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALReceiptControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { createALOutboundReceiptWorkEvidence } from '@shared/alm/outbound/lane/al-outbound-receipt-observation.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import { ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import { ALWorkPhaseCapture } from '@shared/alm/work/al-work-phase-capture.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import type { WsQueueBoxServerReceiptObserver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

import { createApiV1WsReceiptObserver } from '../../../../../apps/api-v1/src/composition/create-api-v1-ws-receipt-observer.ts';
import { toSafeApiTimingRecord } from '../../../../../apps/rallar-black-box/scripts/to-safe-api-timing-record.ts';
import {
    isApiTimingRecord,
    toSafeApiWsReceiptObservation,
    type SafeApiWsReceiptObservationDto
} from '../../../../../apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts';

import { decodeOutboundTestPayload } from '../outbound-test-payload.ts';
import { fakePort } from './al-work-test-entries.ts';

interface ObservedClock {
    readonly clock: ALWorkPhaseCapture.Clock;
    readonly observer: WsQueueBoxServerReceiptObserver | undefined;
    readonly captureReads: () => number;
    readonly advance: (milliseconds: number) => void;
    readonly advanceOnWrite: (milliseconds: number) => void;
    readonly failNextWrite: () => void;
    readonly retained: () => SafeApiWsReceiptObservationDto[];
}

function createObservedClock(enabled = true): ObservedClock {
    let epoch = 1000;
    let monotonic = 0;
    let captureReads = 0;
    let writeAdvance = 0;
    let failWrite = false;
    const records: string[] = [];
    const clock = { nowEpochMs: () => epoch, nowMonotonicMs: () => monotonic };
    const observer = createApiV1WsReceiptObserver({
        enabled,
        timing: (event) => {
            epoch += writeAdvance;
            monotonic += writeAdvance;
            if (failWrite) {
                failWrite = false;
                throw new Error('optional sink failed');
            }
            records.push(JSON.stringify(event));
        },
        serviceId: 'api',
        publisherId: 'publisher',
        workPhases: {
            serverPeerId: 'server',
            clock: {
                nowEpochMs: () => {
                    captureReads += 1;
                    return epoch;
                },
                nowMonotonicMs: () => {
                    captureReads += 1;
                    return monotonic;
                }
            }
        }
    });
    return {
        clock,
        observer,
        captureReads: () => captureReads,
        advance: (milliseconds: number) => {
            epoch += milliseconds;
            monotonic += milliseconds;
        },
        advanceOnWrite: (milliseconds: number) => {
            writeAdvance = milliseconds;
        },
        failNextWrite: () => {
            failWrite = true;
        },
        retained: () =>
            records.flatMap((line) => {
                const safe = toSafeApiTimingRecord(line);
                const receipt = toSafeApiWsReceiptObservation(safe?.wsReceipt);
                return receipt === undefined ? [] : [receipt];
            })
    };
}

function getReceiptWork(queue: InMemoryQueueBox, namespace: string): ResourceEntry[] {
    return queue.peekKeys().map((key) => queue.peek(key)!).filter((entry) => entry.typeId === toALOutboundWorkType(namespace));
}

it('retains the actual page phase durations before outbound projection and flushes after release', async () => {
    const observed = createObservedClock();
    const released: string[] = [];
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const port = fakePort({ claims: ['first', 'second'], onRelease: (claim) => released.push(claim.entry.key.contextId) });
    const handler = new ALWorkHandler({
        workerId: 'phase-worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: observed.clock.nowEpochMs },
        pageSize: 16,
        readinessMemoryMs: 0,
        phaseCapture: observed.observer?.phaseCapture,
        batchObservations: ALWorkBatchObservations,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (selected) => {
            observed.advance(7);
            return {
                claims: await selected.claim({ maxCount: 2, observedEntries: undefined }),
                nextReadyAtMs: undefined,
                selectionDurationMs: 0,
                claimDurationMs: 7,
                earliestDueAtMs: undefined
            };
        },
        claimSuccessor: undefined,
        runClaim: async (claim) => {
            expect(observed.retained()).toEqual([]);
            observed.advance(claim.entry.key.contextId === 'first' ? 11 : 18);
            return { status: 'completed' };
        },
        diagnostics: undefined
    });
    const releaseAll = port.releaseAll;
    port.releaseAll = async (releases) => {
        await releaseAll(releases);
        observed.advance(5);
    };
    onTestFinished(() => handler.dispose());
    await handler.ready();
    expect(released).toEqual(['first', 'second']);
    expect(observed.retained()).toContainEqual(expect.objectContaining({
        kind: 'outbound-work-batch',
        workerId: 'phase-worker',
        claimedCount: 2,
        startedAtMs: 1007,
        batchStartedAtMs: 1000,
        batchEndedAtMs: 1041,
        durationMs: 41,
        selectionDurationMs: 0,
        claimDurationMs: 7,
        runDurationMs: 29,
        releaseDurationMs: 5,
        durationClock: 'api-epoch',
        dueWait: 'uncaptured'
    }));
});

it.each(['returned', 'threw', 'expired', 'neutral', 'capture-off'] as const)(
    'preserves actual receipt work and private canonical/callback facts for %s',
    async (scenario) => {
        const observed = createObservedClock(scenario !== 'capture-off');
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        vi.spyOn(Date, 'now').mockImplementation(observed.clock.nowEpochMs);
        vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(observed.clock.nowEpochMs()));
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(scenario === 'expired' ? 1000 : observed.clock.nowEpochMs())
        );
        const engine = new InboxOutboxEngine();
        onTestFinished(() => engine.stop());
        const resources = createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeOutboundTestPayload,
            canonicalQueue: queue,
            queueEngine: engine,
            nowMs: observed.clock.nowEpochMs
        });
        const readWork = resources.admissionStore.readWorkSnapshot.bind(resources.admissionStore);
        vi.spyOn(resources.admissionStore, 'readWorkSnapshot').mockImplementation(async (entry, canonical) => {
            observed.advance(scenario === 'expired' ? 30001 : 8);
            if (scenario === 'threw' || scenario === 'expired') {
                throw new ALAdmissionCorruptionError('canonical', new Error('invalid canonical row'));
            }
            return await readWork(entry, canonical);
        });
        const sent: string[] = [];
        let sendAttempts = 0;
        const message = {
            ...newALReceiptControlMessage({ v: 3, msgId: 'receipt', senderId: 'server', ts: 1000 }, {
                msgId: 'subject',
                originPeerId: 'origin',
                phase: 'complete',
                expectedRecipientPeerIds: ['recipient'],
                confirmedRecipientPeerIds: ['recipient'],
                snapshotVersion: 7,
                observedAtEpochMs: 1000
            }),
            constraints: { expiresAtMs: 31000 }
        };
        const runtime = new ALOutboundMessageRuntime({
            ...resources,
            carrier: 'ws',
            dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
            receiptWorkCapture: scenario === 'capture-off' ? undefined : {
                batchObservations: ALWorkBatchObservations,
                createEvidence: createALOutboundReceiptWorkEvidence,
                phaseCapture: observed.observer?.phaseCapture,
                observer: (observation) => observed.observer?.({ ...observation, serverPeerId: 'server' })
            },
            toOutboxEntry: (receipt) => QueueBoxUtilities.toResourceEntryFromMsg(receipt, 'receipt-test'),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: (receipt) => ({
                msg: receipt,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ text: 'exact-receipt-frame' }]
            }),
            planDequeuedMessage: (receipt) => ({ msg: receipt, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            decodePreparedMessage: decodeOutboundTestPayload,
            sendPreparedMessage: async (prepared) => {
                observed.advance(11);
                sendAttempts += 1;
                if (scenario === 'neutral' && sendAttempts === 1) {
                    return { status: 'not-ready', submissionAttempted: false, retryAfterMs: 2 };
                }
                sent.push(prepared.text!);
                return { status: 'sent', submissionAttempted: true };
            },
            afterDequeueAdmission: undefined,
            planRepairMessage: undefined,
            diagnostics: undefined,
            settlements: undefined
        });
        onTestFinished(() => runtime.dispose());
        const enqueued = await runtime.enqueueIfAbsent(message);
        expect(enqueued.verdict.kind, JSON.stringify(enqueued.verdict)).toBe('admitted');
        await engine.executeOnce();
        if (scenario === 'neutral') {
            await expect.poll(() => getReceiptWork(queue, resources.admissionStore.namespace).map((entry) => entry.status)).toEqual([EntityStatus.RETRY]);
            const held = getReceiptWork(queue, resources.admissionStore.namespace);
            expect(held).toHaveLength(1);
            expect(held[0].status).toBe(EntityStatus.RETRY);
            expect(held[0].dequeueAudit.attempts).toBe(0);
            observed.advance(2);
            engine.wake();
            await engine.executeOnce();
        }
        await expect.poll(() => getReceiptWork(queue, resources.admissionStore.namespace).map((entry) => entry.status)).toEqual([
            scenario === 'threw' ? EntityStatus.NON_RETRYABLE : EntityStatus.COMPLETED
        ]);
        expect(sent).toEqual(scenario === 'threw' || scenario === 'expired' ? [] : ['exact-receipt-frame']);
        if (scenario !== 'expired') {
            expect((await resources.admissionStore.readSentMessage('receipt'))?.msg.id.msgId).toBe('receipt');
        }
        const completed = getReceiptWork(queue, resources.admissionStore.namespace);
        expect(completed).toHaveLength(1);
        expect(completed.map((entry) => entry.status)).toEqual([scenario === 'threw' ? EntityStatus.NON_RETRYABLE : EntityStatus.COMPLETED]);
        if (scenario !== 'capture-off') {
            await expect.poll(() => observed.retained().filter(isApiTimingRecord).filter((record) => record.kind === 'outbound-claim-phases')).toHaveLength(
                scenario === 'neutral' ? 2 : 1
            );
        }
        const records = observed.retained();
        if (scenario === 'capture-off') {
            expect(records).toEqual([]);
            expect(observed.captureReads()).toBe(0);
            return;
        }
        if (scenario === 'threw' || scenario === 'expired') {
            expect(records).toContainEqual(expect.objectContaining({
                kind: 'outbound-claim-phases',
                lookupOutcome: scenario,
                callbackOutcome: scenario === 'threw' ? 'threw' : 'completed',
                callbackStartedAtMs: 1000,
                callbackEndedAtMs: scenario === 'threw' ? 1008 : 31001
            }));
            expect(records.some((record) => isApiTimingRecord(record) && record.kind === 'receipt-work')).toBe(false);
            return;
        }
        if (scenario === 'neutral') {
            const claims = records.filter(isApiTimingRecord).filter((record) => record.kind === 'outbound-claim-phases');
            expect(claims).toHaveLength(2);
            expect(claims.map((claim) => [claim.attempts, claim.claimSequence, claim.callbackOutcome])).toEqual([[1, 1, 'not-ready'], [1, 2, 'completed']]);
            expect(claims[0].workLocator).toBe(claims[1].workLocator);
            expect(claims.map((claim) => claim.storedClaimStartedAtMs)).toEqual([1000, 1021]);
            return;
        }
        expect(records).toContainEqual(expect.objectContaining({
            kind: 'outbound-claim-phases',
            callbackStartedAtMs: 1000,
            lookupReturnedAtMs: 1008,
            callbackEndedAtMs: 1019,
            lookupDurationMs: 8,
            callbackDurationMs: 19,
            lookupOutcome: 'returned',
            callbackOutcome: 'completed',
            durationClock: 'api-monotonic',
            claimSequence: 1
        }));
        expect(records).toContainEqual(
            expect.objectContaining({ kind: 'receipt-work', receiptControlMsgId: 'receipt', effectKind: 'send-prepared', claimSequence: 1 })
        );
    }
);

it('closes the private producer idempotently and retains a safe loss summary', () => {
    const observed = createObservedClock();
    observed.observer?.phaseCapture?.close();
    observed.observer?.phaseCapture?.close();
    expect(observed.retained()).toEqual([expect.objectContaining({
        kind: 'outbound-phase-summary',
        closed: true,
        attemptedRecords: 0,
        emittedRecords: 0,
        overflowRecords: 0,
        sinkFailures: 0,
        clockFailures: 0
    })]);
});

it.each(['outbound-work-batch', 'outbound-phase-flush'] as const)('settles reentrant close during %s after every in-flight write', (closeAt) => {
    const records: ALWorkPhaseCapture.Observation[] = [];
    const capture = new ALWorkPhaseCapture({
        serverPeerId: 'server',
        maxRecords: 4096,
        maxBytes: 8 * 1024 * 1024,
        clock: { nowEpochMs: () => 1000, nowMonotonicMs: () => 0 },
        writeObservation: (observation) => {
            records.push(observation);
            if (observation.kind === closeAt) {
                capture.close();
            }
            return { status: 'emitted', bytes: 100 };
        }
    });
    capture.beginBatch('worker');
    capture.recordBatch(
        {
            kind: 'work-batch',
            workerId: 'worker',
            durationMs: 1,
            claimedCount: 1,
            completedCount: 1,
            rescheduledCount: 0,
            rejectedCount: 0,
            selectionDurationMs: 0,
            claimDurationMs: 0,
            runDurationMs: 1,
            releaseDurationMs: 0,
            queueWaitMs: 0,
            startedAtMs: 1000
        },
        1000,
        1001
    );
    capture.flush();
    expect(records.map((record) => record.kind)).toEqual(['outbound-work-batch', 'outbound-phase-flush', 'outbound-phase-summary']);
    expect(records[2]).toEqual(expect.objectContaining({ closed: true, emittedRecords: 2, emittedBytes: 200 }));
});

it('retains failed-page loss after a later successful page without replacing the original error', async () => {
    const observed = createObservedClock();
    const original = new ALAdmissionCorruptionError('work', new Error('canonical corruption'));
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const released: string[] = [];
    const port = fakePort({ claims: ['work'], onRelease: (claim) => released.push(claim.entry.key.contextId) });
    let fail = true;
    const handler = new ALWorkHandler({
        workerId: 'worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: observed.clock.nowEpochMs },
        pageSize: 16,
        readinessMemoryMs: 0,
        phaseCapture: observed.observer?.phaseCapture,
        batchObservations: ALWorkBatchObservations,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (selected) => {
            if (fail) {
                fail = false;
                throw original;
            }
            return {
                claims: await selected.claim({ maxCount: 1, observedEntries: undefined }),
                nextReadyAtMs: undefined,
                selectionDurationMs: 0,
                claimDurationMs: 0,
                earliestDueAtMs: undefined
            };
        },
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    });
    onTestFinished(() => handler.dispose());
    await expect(handler.ready()).rejects.toBe(original);
    await handler.ready();
    expect(released).toEqual(['work']);
    observed.observer?.phaseCapture?.close();
    expect(observed.retained()).toContainEqual(expect.objectContaining({ kind: 'outbound-phase-summary', abandonedBatches: 1, unfinishedBatches: 0 }));
});

it('adds no handler endpoint clock reads when diagnostics and capture are absent', async () => {
    let clockReads = 0;
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const port = fakePort({ claims: ['work'], onRelease: () => {} });
    const handler = new ALWorkHandler({
        workerId: 'quiet-worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: {
            nowMs: () => {
                clockReads += 1;
                return 1000;
            }
        },
        pageSize: 16,
        readinessMemoryMs: 0,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (selected) => ({
            claims: await selected.claim({ maxCount: 1, observedEntries: undefined }),
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs: 0,
            earliestDueAtMs: undefined
        }),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    });
    onTestFinished(() => handler.dispose());
    await handler.ready();
    expect(clockReads).toBeLessThanOrEqual(6);
    engine.wake();
    await engine.executeOnce();
    expect(clockReads).toBeLessThanOrEqual(8);
});

it('keeps all emitted phase records including the final summary inside the composition record cap', () => {
    const observed = createObservedClock();
    const capture = observed.observer!.phaseCapture!;
    for (let index = 0; index < 4100; index += 1) {
        capture.recordReadiness({ kind: 'readiness-probe', workerId: 'worker', cause: 'no-memory', readyAtMs: 'none', durationMs: 0 }, 1000, 1000);
    }
    capture.close();
    const records = observed.retained();
    expect(records.length).toBeLessThanOrEqual(4096);
    expect(records.at(-1)).toEqual(expect.objectContaining({ kind: 'outbound-phase-summary', maxRecords: 4096, overflowRecords: 6 }));
});

it('keeps optional failed endpoint clocks from replacing successful mandatory release', async () => {
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const released: string[] = [];
    const observations: ALWorkPhaseCapture.Observation[] = [];
    const capture = new ALWorkPhaseCapture({
        serverPeerId: 'server',
        maxRecords: 4096,
        maxBytes: 8 * 1024 * 1024,
        clock: {
            nowEpochMs: () => {
                throw new Error('optional clock failed');
            },
            nowMonotonicMs: () => 0
        },
        writeObservation: (observation) => {
            observations.push(observation);
            return { status: 'emitted', bytes: 100 };
        }
    });
    let businessClockReads = 0;
    const handler = new ALWorkHandler({
        workerId: 'worker',
        port: fakePort({ claims: ['work'], onRelease: (claim) => released.push(claim.entry.key.contextId) }),
        queueEngine: engine,
        ownsQueueEngine: false,
        pageSize: 16,
        readinessMemoryMs: 0,
        clock: {
            nowMs: () => {
                businessClockReads += 1;
                if (businessClockReads > 6) {
                    throw new Error('unexpected optional business read');
                }
                return 1000;
            }
        },
        phaseCapture: capture,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (port) => ({
            claims: await port.claim({ maxCount: 1, observedEntries: undefined }),
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs: 0,
            earliestDueAtMs: undefined
        }),
        claimSuccessor: undefined,
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: undefined
    });
    onTestFinished(() => handler.dispose());
    await handler.ready();
    expect(released).toEqual(['work']);
    capture.close();
    expect(observations.at(-1)).toEqual(expect.objectContaining({ kind: 'outbound-phase-summary', clockFailures: 1, abandonedBatches: 1 }));
});

it('measures deferred sink cost separately and records failure after mandatory release and readiness', async () => {
    const observed = createObservedClock();
    observed.advanceOnWrite(13);
    observed.failNextWrite();
    const engine = new InboxOutboxEngine();
    onTestFinished(() => engine.stop());
    const released: string[] = [];
    const port = fakePort({
        claims: ['work'],
        onRelease: (claim) => {
            expect(observed.retained()).toEqual([]);
            released.push(claim.entry.key.contextId);
        }
    });
    const handler = new ALWorkHandler({
        workerId: 'worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: observed.clock.nowEpochMs },
        pageSize: 16,
        readinessMemoryMs: 0,
        phaseCapture: observed.observer?.phaseCapture,
        readNextReadyAtMs: async () => {
            expect(released).toEqual(['work']);
            return 1200;
        },
        selectReady: async (selected) => ({
            claims: await selected.claim({ maxCount: 1, observedEntries: undefined }),
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs: 0,
            earliestDueAtMs: undefined
        }),
        claimSuccessor: undefined,
        runClaim: async () => {
            observed.advance(11);
            return { status: 'completed' };
        },
        diagnostics: undefined
    });
    onTestFinished(() => handler.dispose());
    await handler.ready();
    expect(released).toEqual(['work']);
    await engine.executeOnce();
    await handler.dispose();
    observed.observer?.phaseCapture?.close();
    const records = observed.retained();
    expect(records).toContainEqual(expect.objectContaining({ kind: 'outbound-phase-flush', flushedRecordCount: 1, durationMs: 13 }));
    expect(records).toContainEqual(
        expect.objectContaining({
            kind: 'outbound-readiness-probe',
            cause: 'no-memory',
            readyAtMs: 1200,
            durationMs: 0,
            probeStartedAtMs: 1037,
            probeEndedAtMs: 1037
        })
    );
    expect(records.at(-1)).toEqual(expect.objectContaining({ kind: 'outbound-phase-summary', sinkFailures: 1, unfinishedBatches: 0, abandonedBatches: 0 }));
});

it('bounds actual emitted API JSONL bytes and reconciles whole-row overflow', () => {
    const rows: string[] = [];
    const observer = createApiV1WsReceiptObserver({
        enabled: true,
        timing: (event) => rows.push(JSON.stringify(event) + '\n'),
        serviceId: 's'.repeat(512),
        publisherId: 'p'.repeat(512),
        workPhases: { serverPeerId: 'q'.repeat(512), clock: { nowEpochMs: () => 1000, nowMonotonicMs: () => 0 } }
    })!;
    const capture = observer.phaseCapture!;
    for (let index = 0; index < 4100; index += 1) {
        const claim = capture.beginClaim({
            workerId: 'w'.repeat(512),
            workLocator: 'k'.repeat(512),
            attempts: 1,
            storedClaimStartedAtMs: 10,
            batchStartedAtMs: 1000
        })!;
        capture.finishClaim({
            claim,
            lookupReturned: capture.readClock(),
            lookupOutcome: 'returned',
            callbackOutcome: 'completed',
            effectKind: 'send-prepared',
            effectLocator: 'e'.repeat(512)
        });
    }
    capture.close();
    const byteLengths = rows.map((row) => new TextEncoder().encode(row).length);
    expect(byteLengths.every((bytes) => bytes <= 65536)).toBe(true);
    expect(byteLengths.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(rows.length).toBeLessThanOrEqual(4096);
    const safe = rows.map(toSafeApiTimingRecord);
    expect(safe.every((record) => record !== undefined)).toBe(true);
    const summary = toSafeApiWsReceiptObservation(safe.at(-1)?.wsReceipt);
    expect(summary).toEqual(
        expect.objectContaining({
            kind: 'outbound-phase-summary',
            emittedRecords: rows.length - 1,
            emittedBytes: byteLengths.slice(0, -1).reduce((total, bytes) => total + bytes, 0)
        })
    );
    expect(summary?.overflowRecords).toBeGreaterThan(0);
});

it('retains a closed scalar codec and rejects whole unsafe phase records', () => {
    const observed = createObservedClock();
    const capture = observed.observer!.phaseCapture!;
    capture.beginBatch('unfinished-worker');
    capture.recordReadiness({ kind: 'readiness-probe', workerId: 'worker', cause: 'no-memory', readyAtMs: 'none', durationMs: 0 }, 1000, 1000);
    const claim = capture.beginClaim({
        workerId: 'unfinished-worker',
        workLocator: 'hashed-key',
        attempts: 1,
        storedClaimStartedAtMs: 99,
        batchStartedAtMs: 1000
    })!;
    capture.finishClaim({
        claim,
        lookupReturned: capture.readClock(),
        lookupOutcome: 'returned',
        callbackOutcome: 'completed',
        effectKind: 'send-prepared',
        effectLocator: 'hashed-effect'
    });
    capture.close();
    const records = observed.retained();
    expect(records.at(-1)).toEqual(expect.objectContaining({ kind: 'outbound-phase-summary', unfinishedBatches: 1 }));
    for (const record of records) {
        expect(toSafeApiWsReceiptObservation({ ...record, resource: { arbitrary: 'full-payload' }, authorization: 'secret' })).toEqual(record);
        expect(toSafeApiWsReceiptObservation({ ...record, serverPeerId: 'unsafe identity' })).toBeUndefined();
    }
    const phases = records.find((record) => record.kind === 'outbound-claim-phases')!;
    expect(toSafeApiWsReceiptObservation({ ...phases, claimSequence: 0 })).toBeUndefined();
    expect(toSafeApiWsReceiptObservation({ ...phases, callbackDurationMs: Number.NaN })).toBeUndefined();
    expect(toSafeApiWsReceiptObservation({ ...phases, workLocator: { resource: 'full-payload' } })).toBeUndefined();
    expect(toSafeApiWsReceiptObservation({ ...records.at(-1), closed: false })).toBeUndefined();
});
