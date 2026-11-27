import { describe, expect, it, onTestFinished } from 'vitest';

import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import type { ALReceiptRecordEndedHead, ALReceiptRecordOpening } from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import {
    createInMemoryALReceiptRecordStores,
    type ALReceiptRecordStores
} from '@shared/alm/receipt-record/al-receipt-record-stores.ts';
import {
    toALReceiptRecordWorkKey,
    toALReceiptRecordWorkType,
    type ALReceiptRecordWork
} from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import {
    AL_RECEIPT_RECORD_NOT_DUE_WAIT_MS,
    AL_RECEIPT_RECORD_WORK_LEASE_MS,
    ALReceiptRecordWorker
} from '@shared/alm/receipt-record/al-receipt-record-worker.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import { computeALWorkEntry } from '@shared/alm/work/compute-al-work-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { createDelegatingALAdmissionWorkBackend } from '../create-delegating-al-admission-work-backend.ts';

const T = 1_760_000_000_000;
const DEADLINE_AT_MS = T + 5_000;
const ref = { originPeerId: 'origin', msgId: 'msg-1' };
const opening: ALReceiptRecordOpening = {
    ...ref,
    traceId: 'trace-1',
    expectedRecipientPeerIds: ['r1', 'r2'],
    neverSentRecipientPeerIds: [],
    snapshotVersion: 1,
    deadlineAtMs: DEADLINE_AT_MS
};
const deadlineWork: ALReceiptRecordWork = { kind: 'deadline', ref };

interface MutableClock {
    nowMs: number;
}

interface WorkerFixture {
    readonly queueClock: MutableClock;
    readonly recordClock: MutableClock;
    readonly stores: ALReceiptRecordStores;
    readonly record: ALReceiptRecord;
    readonly worker: ALReceiptRecordWorker;
    readonly engine: InboxOutboxEngine;
    readonly delivered: ALReceiptRecordEndedHead[];
}

interface WorkerFixtureInput {
    /** How far the record's and the worker's clock runs behind the stores' queue. */
    readonly recordBehindQueueMs: number;
    readonly writeEndedReceipt: (ended: ALReceiptRecordEndedHead) => Promise<void>;
}

interface WorkerInstance {
    readonly worker: ALReceiptRecordWorker;
    readonly engine: InboxOutboxEngine;
}

interface WorkerInstanceInput {
    readonly record: ALReceiptRecord;
    readonly stores: ALReceiptRecordStores;
    readonly workerClock: MutableClock;
    readonly writeEndedReceipt: (ended: ALReceiptRecordEndedHead) => Promise<void>;
}

/** One server instance's worker, on an engine of its own, over the shared stores. */
function createWorkerInstance(input: WorkerInstanceInput, workerId: string): WorkerInstance {
    const { workerClock } = input;
    const engine = new InboxOutboxEngine({
        nowEpochMs: () => workerClock.nowMs,
        random: () => 0,
        reportTaskFailure: () => undefined
    });
    const worker = new ALReceiptRecordWorker({
        record: input.record,
        stores: input.stores,
        workerId,
        queueEngine: engine,
        clock: { nowMs: () => workerClock.nowMs },
        random: () => 0,
        writeEndedReceipt: input.writeEndedReceipt
    });
    onTestFinished(() => worker.dispose());
    return { worker, engine };
}

function createWorkerFixture(input: WorkerFixtureInput): WorkerFixture {
    const queueClock = { nowMs: T };
    const recordClock = { nowMs: T - input.recordBehindQueueMs };
    const stores = createInMemoryALReceiptRecordStores('server-ws-qbox:test', () => queueClock.nowMs);
    const record = new ALReceiptRecord({
        backend: stores.backend,
        namespace: stores.namespace,
        nowMs: () => recordClock.nowMs
    });
    const delivered: ALReceiptRecordEndedHead[] = [];
    const { worker, engine } = createWorkerInstance({
        record,
        stores,
        workerClock: recordClock,
        writeEndedReceipt: async (ended) => {
            await input.writeEndedReceipt(ended);
            delivered.push(ended);
        }
    }, 'receipt-record-worker-test');
    return { queueClock, recordClock, stores, record, worker, engine, delivered };
}

function createDeliveringFixture(): WorkerFixture {
    return createWorkerFixture({ recordBehindQueueMs: 0, writeEndedReceipt: async () => {} });
}

function setNowMs(fixture: WorkerFixture, nowMs: number): void {
    const behindMs = fixture.queueClock.nowMs - fixture.recordClock.nowMs;
    fixture.queueClock.nowMs = nowMs;
    fixture.recordClock.nowMs = nowMs - behindMs;
}

/**
 * Two engine rounds, each followed by a macrotask: the memory stores settle on microtasks, so a batch a round (or a
 * `committed()`) started has released its claims before the next round asks for work.
 */
async function runRounds(fixture: Pick<WorkerFixture, 'engine'>): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
        await fixture.engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function readPhase(record: ALReceiptRecord): Promise<string | undefined> {
    return (await record.read(ref)).right?.head.phase;
}

async function readDeadlineRow(stores: ALReceiptRecordStores): Promise<ResourceEntry | undefined> {
    return await stores.backend.workQueue.getItem(toALReceiptRecordWorkKey(stores.namespace, 'deadline', ref));
}

async function readEndedRow(stores: ALReceiptRecordStores): Promise<ResourceEntry | undefined> {
    return await stores.backend.workQueue.getItem(toALReceiptRecordWorkKey(stores.namespace, 'ended', ref));
}

async function openCommitted(fixture: WorkerFixture): Promise<void> {
    expect((await fixture.record.open(opening)).right?.head.phase).toBe('open');
    fixture.worker.committed(deadlineWork, DEADLINE_AT_MS);
    await runRounds(fixture);
}

async function confirm(record: ALReceiptRecord, recipientPeerId: string): Promise<void> {
    expect((await record.count({ ...ref, recipientPeerId, kind: 'confirmed' })).right?.disposition).toBe('counted');
}

describe('ALReceiptRecordWorker', () => {
    // A record whose namespace were the owner's store namespace itself would write its heads, confirmations and work
    // among the owner's own rows, where a key or a work type of the one could collide with the other's.
    it('keeps the record under its own namespace', () => {
        const stores = createInMemoryALReceiptRecordStores('server-ws-qbox:test', () => T);

        expect(stores.namespace).toBe('server-ws-qbox:test:receipt:record');
    });

    // A worker that ended a receipt before its deadline, or never ended it, would leave the sender without the
    // terminal receipt the record owes it.
    it('ends a receipt timed-out when its deadline work comes due', async () => {
        const fixture = createDeliveringFixture();
        await openCommitted(fixture);
        await confirm(fixture.record, 'r1');

        setNowMs(fixture, DEADLINE_AT_MS - 1);
        await runRounds(fixture);
        expect(await readPhase(fixture.record)).toBe('open');
        expect(fixture.delivered).toEqual([]);

        setNowMs(fixture, DEADLINE_AT_MS);
        await runRounds(fixture);
        const ended = (await fixture.record.read(ref)).right?.head;
        expect(ended?.phase).toBe('timed-out');
        expect(fixture.delivered).toEqual([ended]);
        expect(fixture.delivered[0]?.confirmedRecipientPeerIds).toEqual(['r1']);
    });

    // The instance that ends a receipt may not be the one that delivers it: a survivor must find the ended work at
    // its next readiness read, though no commit of its own announced it.
    it('delivers a receipt another instance ended', async () => {
        const fixture = createDeliveringFixture();
        await openCommitted(fixture);
        const otherRecord = new ALReceiptRecord({
            backend: fixture.stores.backend,
            namespace: fixture.stores.namespace,
            nowMs: () => fixture.recordClock.nowMs
        });

        setNowMs(fixture, T + 1_000);
        await confirm(otherRecord, 'r1');
        await confirm(otherRecord, 'r2');
        expect((await otherRecord.end(ref)).right?.phase).toBe('complete');
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([]);

        setNowMs(fixture, T + 1_000 + AL_WORK_READINESS_MEMORY_MS);
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([(await fixture.record.read(ref)).right?.head]);
        expect(fixture.delivered[0]?.phase).toBe('complete');
    });

    // A set that completed while nobody called `end` must not be reported timed-out at its deadline.
    it('ends complete at the deadline a set that was complete under an open head', async () => {
        const fixture = createDeliveringFixture();
        await openCommitted(fixture);
        await confirm(fixture.record, 'r1');
        await confirm(fixture.record, 'r2');

        setNowMs(fixture, DEADLINE_AT_MS);
        await runRounds(fixture);
        expect(fixture.delivered[0]?.phase).toBe('complete');
    });

    // Review Focus 4: the queue may call a deadline row due on a clock the record has not reached. Completing the row
    // would lose the receipt's end; a retry would spend attempts and back off; releasing it due at once would spin.
    it('waits a bounded time when the queue calls a deadline due before the record does', async () => {
        const fixture = createWorkerFixture({ recordBehindQueueMs: 100, writeEndedReceipt: async () => {} });
        await openCommitted(fixture);
        setNowMs(fixture, DEADLINE_AT_MS);
        await fixture.record.open({ ...opening, msgId: 'msg-2', deadlineAtMs: T + 20_000 });
        fixture.worker.committed({ kind: 'deadline', ref: { ...ref, msgId: 'msg-2' } }, T + 20_000);

        const releasedAtMs = DEADLINE_AT_MS + AL_RECEIPT_RECORD_NOT_DUE_WAIT_MS;
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([]);
        expect(await readPhase(fixture.record)).toBe('open');
        const released = await readDeadlineRow(fixture.stores);
        expect(released?.status).toBe(EntityStatus.RETRY);
        expect(released?.dequeueAudit.attempts).toBe(0);
        expect(released?.dequeueAudit.nextTs?.epochMilliseconds).toBe(releasedAtMs);

        setNowMs(fixture, releasedAtMs - 101);
        fixture.worker.committed({ kind: 'deadline', ref: { ...ref, msgId: 'msg-2' } }, T + 20_000);
        await runRounds(fixture);
        await runRounds(fixture);
        const waiting = await readDeadlineRow(fixture.stores);
        expect(waiting?.dequeueAudit.attempts).toBe(0);
        expect(waiting?.dequeueAudit.nextTs?.epochMilliseconds).toBe(releasedAtMs);

        fixture.recordClock.nowMs = releasedAtMs;
        fixture.queueClock.nowMs = releasedAtMs + 100;
        await runRounds(fixture);
        expect(await readPhase(fixture.record)).toBe('timed-out');
        expect(fixture.delivered).toEqual([(await fixture.record.read(ref)).right?.head]);
    });

    it('waits what the record still lacks when that is more than the floor', async () => {
        const fixture = createWorkerFixture({ recordBehindQueueMs: 2_000, writeEndedReceipt: async () => {} });
        await openCommitted(fixture);
        setNowMs(fixture, DEADLINE_AT_MS);
        await fixture.record.open({ ...opening, msgId: 'msg-2', deadlineAtMs: T + 20_000 });
        fixture.worker.committed({ kind: 'deadline', ref: { ...ref, msgId: 'msg-2' } }, T + 20_000);

        await runRounds(fixture);
        const released = await readDeadlineRow(fixture.stores);
        expect(released?.status).toBe(EntityStatus.RETRY);
        expect(released?.dequeueAudit.attempts).toBe(0);
        expect(released?.dequeueAudit.nextTs?.epochMilliseconds).toBe(DEADLINE_AT_MS + 2_000);
    });

    // A delivery that failed must be retried from the stored head, or the sender never hears the receipt's end.
    it('delivers again after a failed delivery', async () => {
        let failures = 1;
        const fixture = createWorkerFixture({
            recordBehindQueueMs: 0,
            writeEndedReceipt: async () => {
                if (failures > 0) {
                    failures -= 1;
                    throw new Error('delivery failed');
                }
            }
        });
        await openCommitted(fixture);

        setNowMs(fixture, DEADLINE_AT_MS);
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([]);
        const failed = await readEndedRow(fixture.stores);
        expect(failed?.status).toBe(EntityStatus.RETRY);
        expect(failed?.dequeueAudit.attempts).toBe(1);

        setNowMs(fixture, DEADLINE_AT_MS + 1_000);
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([(await fixture.record.read(ref)).right?.head]);
        expect((await readEndedRow(fixture.stores))?.status).toBe(EntityStatus.COMPLETED);
    });

    // A delivery whose lease ran out (a slow callback, or a crash between the delivery and the release) is claimed
    // again by another instance through the queue's lease sweep. Ended work is at-least-once: a worker that skipped
    // the second delivery, or marked the row done on the first claim alone, would hide that from the owner.
    it('delivers an ended receipt again when its row is claimed again', async () => {
        let releaseFirstDelivery = (): void => {};
        const firstDelivery = new Promise<void>((resolve) => {
            releaseFirstDelivery = resolve;
        });
        let deliveries = 0;
        const fixture = createWorkerFixture({
            recordBehindQueueMs: 0,
            writeEndedReceipt: async () => {
                deliveries += 1;
                if (deliveries === 1) {
                    await firstDelivery;
                }
            }
        });
        await openCommitted(fixture);
        await confirm(fixture.record, 'r1');
        await confirm(fixture.record, 'r2');
        const ended = await fixture.record.end(ref);
        expect(ended.right?.phase).toBe('complete');
        fixture.worker.committed({ kind: 'ended', ref }, fixture.recordClock.nowMs);
        await runRounds(fixture);
        expect((await readEndedRow(fixture.stores))?.status).toBe(EntityStatus.RESERVED);

        setNowMs(fixture, T + AL_RECEIPT_RECORD_WORK_LEASE_MS + 1);
        const survivor = createWorkerInstance({
            record: fixture.record,
            stores: fixture.stores,
            workerClock: fixture.recordClock,
            writeEndedReceipt: async (head) => {
                fixture.delivered.push(head);
            }
        }, 'receipt-record-worker-survivor');
        await runRounds(survivor);
        expect(fixture.delivered).toEqual([ended.right]);
        expect((await readEndedRow(fixture.stores))?.status).toBe(EntityStatus.COMPLETED);

        releaseFirstDelivery();
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([ended.right, ended.right]);
        expect((await readEndedRow(fixture.stores))?.status).toBe(EntityStatus.COMPLETED);
    });

    // The deadline work of a receipt already ended must neither end it again nor deliver its receipt twice.
    it('writes nothing for a deadline of a receipt already ended', async () => {
        const fixture = createDeliveringFixture();
        await openCommitted(fixture);
        await confirm(fixture.record, 'r1');
        await confirm(fixture.record, 'r2');
        const ended = await fixture.record.end(ref);
        expect(ended.right?.phase).toBe('complete');
        fixture.worker.committed({ kind: 'ended', ref }, fixture.recordClock.nowMs);

        setNowMs(fixture, DEADLINE_AT_MS);
        await runRounds(fixture);
        await runRounds(fixture);
        expect(fixture.delivered).toEqual([ended.right]);
        expect((await readDeadlineRow(fixture.stores))?.status).toBe(EntityStatus.COMPLETED);
    });

    // A deadline whose `end` lost a fence while the head stayed open must be tried again: completing the row on any
    // conflict would leave the head open past its deadline, with no terminal receipt.
    it('retries a deadline whose end conflicted while the head stayed open', async () => {
        const conflicting = { armed: false };
        const fixture = createWorkerFixture({ recordBehindQueueMs: 0, writeEndedReceipt: async () => {} });
        const record = new ALReceiptRecord({
            backend: createDelegatingALAdmissionWorkBackend(fixture.stores.backend, {
                write: async (operation, executionExpiresAtMs) => {
                    if (conflicting.armed) {
                        conflicting.armed = false;
                        throw new ALAdmissionBackendConflictError('simulated receipt record conflict');
                    }
                    return await fixture.stores.backend.write(operation, executionExpiresAtMs);
                }
            }),
            namespace: fixture.stores.namespace,
            nowMs: () => fixture.recordClock.nowMs
        });
        const delivered: ALReceiptRecordEndedHead[] = [];
        const { worker, engine } = createWorkerInstance({
            record,
            stores: fixture.stores,
            workerClock: fixture.recordClock,
            writeEndedReceipt: async (ended) => {
                delivered.push(ended);
            }
        }, 'receipt-record-worker-conflicting');
        await fixture.worker.dispose();
        expect((await record.open(opening)).right?.head.phase).toBe('open');
        worker.committed(deadlineWork, DEADLINE_AT_MS);

        setNowMs(fixture, DEADLINE_AT_MS);
        conflicting.armed = true;
        await runRounds({ engine });
        expect(await readPhase(fixture.record)).toBe('open');
        const retried = await readDeadlineRow(fixture.stores);
        expect(retried?.status).toBe(EntityStatus.RETRY);
        expect(retried?.dequeueAudit.attempts).toBe(1);

        setNowMs(fixture, DEADLINE_AT_MS + AL_RECEIPT_RECORD_WORK_LEASE_MS);
        await runRounds({ engine });
        expect(await readPhase(fixture.record)).toBe('timed-out');
        expect(delivered).toEqual([(await fixture.record.read(ref)).right?.head]);
    });

    // A row the record cannot read must be refused for good, not retried until its attempts run out.
    it('refuses work that is not the record\'s', async () => {
        const fixture = createDeliveringFixture();
        const corruptRef = { originPeerId: 'origin', msgId: 'corrupt' };
        const key = toALReceiptRecordWorkKey(fixture.stores.namespace, 'ended', corruptRef);
        await fixture.stores.backend.workQueue.enqueueIfAbsent(computeALWorkEntry({
            key,
            typeId: toALReceiptRecordWorkType(fixture.stores.namespace),
            resource: '{',
            observedAtMs: T,
            readyAtMs: T,
            expireAtTimestamp: T + 60_000
        }));

        fixture.worker.committed({ kind: 'ended', ref: corruptRef }, T);
        await runRounds(fixture);
        expect((await fixture.stores.backend.workQueue.getItem(key))?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(fixture.delivered).toEqual([]);
    });

    // A disposed worker that still claimed would run against a server that is shutting down.
    it('claims nothing once disposed', async () => {
        const fixture = createDeliveringFixture();
        await openCommitted(fixture);
        await fixture.worker.dispose();

        setNowMs(fixture, DEADLINE_AT_MS);
        await runRounds(fixture);
        expect(await readPhase(fixture.record)).toBe('open');
    });
});
