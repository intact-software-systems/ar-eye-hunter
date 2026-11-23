import { toKeyAsString } from '../../queuebox/ResourceEntry.ts';
import type { InboxOutboxEngine } from '../../services/inbox-outbox-engine.ts';
import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler, type ALWorkReadySelection } from '../work/al-work-handler.ts';
import {
    computeALWorkLeaseSweepState,
    createLimitedALWorkLeaseRecovery,
    type ALWorkLeaseRecovery
} from '../work/al-work-lease-recovery.ts';
import {
    createALWorkQueuePort,
    type ALWorkClaim,
    type ALWorkOutcome,
    type ALWorkQueuePort
} from '../work/al-work-queue-port.ts';
import { readALWorkReadyAt } from '../work/read-al-work-ready-at.ts';

import type { ALReceiptRecordRef } from './al-receipt-record-keys.ts';
import type { ALReceiptRecordEndedHead } from './al-receipt-record-rows.ts';
import type { ALReceiptRecordStores } from './al-receipt-record-stores.ts';
import {
    decodeALReceiptRecordWorkEntry,
    toALReceiptRecordWorkKey,
    toALReceiptRecordWorkType,
    type ALReceiptRecordWork
} from './al-receipt-record-work-entry.ts';
import type { ALReceiptRecord } from './al-receipt-record.ts';

export const AL_RECEIPT_RECORD_WORK_LEASE_MS = 10_000;
export const AL_RECEIPT_RECORD_WORK_PAGE_SIZE = 16;
/** The least a deadline row waits when the queue called it due and the record did not. */
export const AL_RECEIPT_RECORD_NOT_DUE_WAIT_MS = 250;

export namespace ALReceiptRecordWorker {
    export interface Dependencies {
        readonly record: ALReceiptRecord;
        readonly stores: ALReceiptRecordStores;
        readonly workerId: string;
        readonly queueEngine: InboxOutboxEngine;
        /** The clock `record` reads; the queue's own due check may read another. */
        readonly clock: { nowMs(): number; };
        readonly random: () => number;
        /** Delivers the terminal receipt of an ended head; a rejection retries the work row. */
        readonly writeEndedReceipt: (ended: ALReceiptRecordEndedHead) => Promise<void>;
    }
}

const COMPLETED: ALWorkOutcome = { status: 'completed' };

/** Claims the record's deadline and ended work on whichever instance runs it; a row claimed twice acts once. */
export class ALReceiptRecordWorker {
    private readonly dependencies: ALReceiptRecordWorker.Dependencies;
    private readonly work: ALWorkHandler;

    constructor(dependencies: ALReceiptRecordWorker.Dependencies) {
        this.dependencies = dependencies;
        const { clock, queueEngine, workerId } = dependencies;
        const leaseRecovery = createLimitedALWorkLeaseRecovery(AL_RECEIPT_RECORD_WORK_LEASE_MS, clock.nowMs());
        this.work = new ALWorkHandler({
            workerId,
            port: createALReceiptRecordWorkPort(dependencies, leaseRecovery),
            queueEngine,
            ownsQueueEngine: false,
            clock,
            pageSize: AL_RECEIPT_RECORD_WORK_PAGE_SIZE,
            readNextReadyAtMs: (port, nowMs) =>
                readALWorkReadyAt(port, {
                    nowMs,
                    pageSize: AL_RECEIPT_RECORD_WORK_PAGE_SIZE,
                    leaseMs: AL_RECEIPT_RECORD_WORK_LEASE_MS,
                    leaseSweeps: computeALWorkLeaseSweepState(leaseRecovery, nowMs),
                    readHeldUntilMs: () => undefined
                }),
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            selectReady: (port, pageSize) => this.selectReady(port, pageSize),
            claimSuccessor: undefined,
            runClaim: (claim) => this.runClaim(claim),
            diagnostics: undefined
        });
    }

    /** After an `open` or `end` this instance committed: the row it wrote and when it comes due. */
    committed(work: ALReceiptRecordWork, dueAtMs: number): void {
        const key = toALReceiptRecordWorkKey(this.dependencies.stores.namespace, work.kind, work.ref);
        this.work.committed({ dueByMs: dueAtMs, writtenKeys: [toKeyAsString(key)] });
    }

    async dispose(): Promise<void> {
        await this.work.dispose();
    }

    /** The record reserves straight from the queue, so it reads no page and observes no row's wait. */
    private async selectReady(port: ALWorkQueuePort, pageSize: number): Promise<ALWorkReadySelection> {
        const { clock } = this.dependencies;
        const startedAtMs = clock.nowMs();
        const claims = await port.claim({ maxCount: pageSize, observedEntries: undefined });
        return {
            claims,
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs: Math.max(0, clock.nowMs() - startedAtMs),
            earliestDueAtMs: undefined
        };
    }

    private async runClaim(claim: ALWorkClaim): Promise<ALWorkOutcome> {
        const work = decodeALReceiptRecordWorkEntry(claim.entry, this.dependencies.stores.namespace);
        return work.kind === 'deadline' ? await this.endAtDeadline(work.ref) : await this.writeEnded(work.ref);
    }

    /**
     * Another instance's `end`, or an end already written, answers a conflict or no head: both leave nothing to do.
     * `not-due` means the queue's clock ran ahead of the record's, so the row waits what the record still lacks.
     */
    private async endAtDeadline(ref: ALReceiptRecordRef): Promise<ALWorkOutcome> {
        this.work.claimCommitted();
        const ended = await this.dependencies.record.end(ref);
        if (ended.left?.kind !== 'not-due') {
            return COMPLETED;
        }
        const nowMs = this.dependencies.clock.nowMs();
        const { deadlineAtMs } = ended.left.view.head.opening;
        return {
            status: 'not-ready',
            readyAtMs: nowMs + Math.max(deadlineAtMs - nowMs, AL_RECEIPT_RECORD_NOT_DUE_WAIT_MS)
        };
    }

    private async writeEnded(ref: ALReceiptRecordRef): Promise<ALWorkOutcome> {
        const head = (await this.dependencies.record.read(ref)).right?.head;
        if (head !== undefined && head.phase !== 'open') {
            await this.dependencies.writeEndedReceipt(head);
        }
        return COMPLETED;
    }
}

function createALReceiptRecordWorkPort(
    dependencies: ALReceiptRecordWorker.Dependencies,
    leaseRecovery: ALWorkLeaseRecovery
): ALWorkQueuePort {
    const { stores, clock, random } = dependencies;
    return createALWorkQueuePort({
        queue: stores.backend.workQueue,
        workTypes: new Set([toALReceiptRecordWorkType(stores.namespace)]),
        leaseMs: AL_RECEIPT_RECORD_WORK_LEASE_MS,
        nowMs: () => clock.nowMs(),
        random,
        leaseRecovery
    });
}
