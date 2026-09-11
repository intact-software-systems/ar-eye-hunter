import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { toError } from '../../resilience/to-error.ts';
import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, type InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from './al-work-queue-port.ts';

export type ALWorkAttemptResult =
    | ALWorkOutcome
    | Readonly<{ status: 'retained'; settled: Promise<ALWorkOutcome>; }>;

export interface ALWorkReadySelection {
    readonly claims: readonly ALWorkClaim[];
    /** A non-negative safe integer (epoch ms) or undefined; `wakeAt` throws `RangeError` on anything else — never clamped here. */
    readonly nextReadyAtMs: number | undefined;
}

export interface ALWorkHandlerDependencies {
    readonly workerId: string;
    readonly port: ALWorkQueuePort;
    readonly queueEngine: InboxOutboxEngine;
    readonly ownsQueueEngine: boolean;
    readonly clock: { nowMs(): number; };
    readonly pageSize: number;
    /**
     * Decides when the engine should run a batch. A non-negative safe integer (epoch ms) at or before
     * `clock.nowMs()` starts one; a later value only reschedules; undefined means no work. Owners whose
     * eligibility rules defer rows pass their own probe so deferred rows never advertise as due. The
     * handler remembers each answer, so this reads storage far less often than the engine asks.
     */
    readonly readNextReadyAtMs: (port: ALWorkQueuePort) => Promise<number | undefined>;
    /**
     * How long one probe's answer stands before storage is read again. An owner whose probe is a pure
     * readiness read passes `AL_WORK_READINESS_MEMORY_MS`; an owner whose probe carries scan state of
     * its own passes `AL_WORK_PROBE_EVERY_ROUND`.
     */
    readonly readinessMemoryMs: number;
    /** Reads eligible work; the port owns reservation. */
    readonly selectReady: (
        port: ALWorkQueuePort,
        pageSize: number
    ) => Promise<ALWorkReadySelection>;
    readonly runClaim: (claim: ALWorkClaim) => Promise<ALWorkAttemptResult>;
    readonly diagnostics: ((event: ALWorkDiagnostics) => void) | undefined;
}

export type ALWorkDiagnostics = ALWorkBatchDiagnostics | ALWorkReadinessProbeDiagnostics;

export interface ALWorkBatchDiagnostics {
    readonly kind: 'work-batch';
    readonly workerId: string;
    readonly durationMs: number;
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly rescheduledCount: number;
    readonly rejectedCount: number;
}

/**
 * Why a probe had no remembered answer to give: one of the four invalidations, the memory reaching
 * its bound, or no memory ever taken. Every storage read this owner spends on readiness has one.
 */
export type ALWorkReadinessProbeCause =
    | 'no-memory'
    | 'external-wake'
    | 'own-commit'
    | 'batch'
    | 'retained-release'
    | 'age-bound';

export interface ALWorkReadinessProbeDiagnostics {
    readonly kind: 'readiness-probe';
    readonly workerId: string;
    readonly cause: ALWorkReadinessProbeCause;
    /** What storage answered: when work is next due, or `none` for no work at all. */
    readonly readyAtMs: number | 'none';
}

/**
 * How long an owner that has neither committed nor run a batch keeps answering from its last probe.
 * It is the engine's own idle ceiling, derived from it so the two cannot drift apart: work another
 * tab wrote, or a row a crashed owner's lease still holds, is discovered on that idle cadence
 * instead of costing a storage read on every engine round.
 */
export const AL_WORK_READINESS_MEMORY_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS;

/**
 * The bound an owner passes when every engine round must reach its probe. An owner whose probe
 * carries scan state of its own -- the inbound rotation, where "nothing here" means nothing at this
 * scan position -- has no answer that can stand for any length of time.
 */
export const AL_WORK_PROBE_EVERY_ROUND = 0;

/** The last probe's answer; `readyAtMs` undefined is the probe reporting no work at all. */
interface ALWorkReadinessMemory {
    readonly readyAtMs: number | undefined;
    readonly observedAtMs: number;
}

interface ALWorkCounts {
    claimedCount: number;
    completedCount: number;
    rescheduledCount: number;
    rejectedCount: number;
}

/** Generic ALM work loop: the port owns reservation and retry policy, this owns the engine task, the batch lifecycle, and how long a probe's answer stands. */
export class ALWorkHandler {
    private readonly dependencies: ALWorkHandlerDependencies;
    private batch: Promise<void> | undefined;
    private bootstrapped = false;
    private readiness: ALWorkReadinessMemory | undefined;
    /** Bumped by every invalidation, so a probe that started before one cannot store its stale answer. */
    private readinessGeneration = 0;
    /** What emptied the memory the next probe replaces; `no-memory` until the first invalidation. */
    private readinessInvalidation: ALWorkReadinessProbeCause = 'no-memory';
    /** Set when committed() lands while a batch is running; drained by one follow-up batch at that batch's end. */
    private commitPending = false;
    private readonly shutdown = new AbortController();

    constructor(dependencies: ALWorkHandlerDependencies) {
        this.dependencies = dependencies;
        dependencies.queueEngine.includeTask(dependencies.workerId, {
            name: dependencies.workerId,
            maxConcurrency: () => 1,
            isWork: () => this.hasReadyWork(),
            runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
            ongoingTasks: []
        });
        // Every writer this engine does not own announces its row with an external-write wake -- a
        // server AppInbox transaction, a pub/sub requeue, another tab. That wake is the moment the
        // remembered answer stopped describing storage, and it reaches every owner sharing the
        // engine, because the writer cannot say which of them the row belongs to. Only those wakes
        // do: the owners' own progress reaches `wake`, which reschedules and announces nothing, so
        // one owner running a batch no longer costs every other owner its memory.
        dependencies.queueEngine.includeWakeListener(
            dependencies.workerId,
            () => this.forgetReadiness('external-wake')
        );
    }

    async ready(): Promise<void> {
        if (this.bootstrapped || this.shutdown.signal.aborted) {
            return;
        }
        await this.runBatch();
        this.bootstrapped = true;
        if (!this.shutdown.signal.aborted && this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.start();
        }
    }

    dispose(): void {
        this.shutdown.abort();
        this.dependencies.queueEngine.excludeWakeListener(this.dependencies.workerId);
        this.dependencies.queueEngine.excludeTask(this.dependencies.workerId);
        if (this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.stop();
        }
    }

    /**
     * After a commit: wakes the engine and runs one batch if idle; never blocks on delivery of
     * unrelated work. It is also the invalidation an owner owes for any write of its own rows it
     * made outside `runBatch`.
     */
    committed(): void {
        this.forgetReadiness('own-commit');
        this.dependencies.queueEngine.wake();
        if (this.batch === undefined) {
            void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
        }
        else {
            this.commitPending = true;
        }
    }

    private async hasReadyWork(): Promise<boolean> {
        if (this.shutdown.signal.aborted || this.batch !== undefined) {
            return false;
        }
        const nowMs = this.dependencies.clock.nowMs();
        const next = await this.readReadyAtMs(nowMs);
        this.dependencies.queueEngine.wakeAt(this.dependencies.workerId, next);
        return next !== undefined && next <= nowMs;
    }

    /**
     * Storage answers only when memory cannot. A remembered "ready at T" answers every round until T
     * arrives without reading anything; a remembered "no work" stands until this owner commits, runs a
     * batch, or the memory ages out.
     */
    private async readReadyAtMs(nowMs: number): Promise<number | undefined> {
        const remembered = this.readiness;
        if (
            remembered !== undefined && nowMs >= remembered.observedAtMs &&
            nowMs - remembered.observedAtMs < this.dependencies.readinessMemoryMs
        ) {
            return remembered.readyAtMs;
        }
        const cause = remembered === undefined ? this.readinessInvalidation : 'age-bound';
        const generation = this.readinessGeneration;
        const readyAtMs = await this.dependencies.readNextReadyAtMs(this.dependencies.port);
        if (generation === this.readinessGeneration) {
            this.readiness = { readyAtMs, observedAtMs: nowMs };
        }
        this.dependencies.diagnostics?.({
            kind: 'readiness-probe',
            workerId: this.dependencies.workerId,
            cause,
            readyAtMs: readyAtMs ?? 'none'
        });
        return readyAtMs;
    }

    /**
     * A commit and a batch both change the rows a probe read, so the answer they invalidate is
     * dropped. That is the rule the memory rests on: **any change to this owner's rows performed
     * outside `runBatch` must reach this method**, or the owner keeps answering from a picture
     * storage no longer supports. The three ways it does are `committed()`, a retained claim's
     * settlement, and the engine wake every writer that is not this owner announces its row with.
     */
    private forgetReadiness(
        cause: 'external-wake' | 'own-commit' | 'batch' | 'retained-release'
    ): void {
        if (this.readiness !== undefined) {
            // The one that emptied a standing memory owns the probe that replaces it: a commit runs
            // a batch, and that batch's own invalidation must not take the credit from the commit.
            this.readinessInvalidation = cause;
        }
        this.readiness = undefined;
        this.readinessGeneration += 1;
    }

    private runBatch(): Promise<void> {
        if (this.shutdown.signal.aborted) {
            return Promise.resolve();
        }
        if (this.batch !== undefined) {
            return this.batch;
        }
        this.batch = this.runSelectedWork().then((counts) => this.wakeAfterProgress(counts)).catch((error) => {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            this.reportBatchFailure(toError(error));
        }).finally(() => {
            this.batch = undefined;
            this.forgetReadiness('batch');
            this.runPendingCommit();
        });
        return this.batch;
    }

    /**
     * A batch that touched work may have written more the page read before it could not see. A batch
     * that touched none advertised its own next time through `wakeAt` and must not re-enter this tick.
     */
    private wakeAfterProgress(counts: ALWorkCounts): void {
        if (counts.claimedCount > 0 || counts.rejectedCount > 0) {
            this.dependencies.queueEngine.wake();
        }
    }

    /** A commit that landed behind the batch earns the immediate re-run the page read missed. */
    private runPendingCommit(): void {
        if (!this.commitPending || this.shutdown.signal.aborted) {
            return;
        }
        this.commitPending = false;
        this.dependencies.queueEngine.wake();
        void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
    }

    private async runSelectedWork(): Promise<ALWorkCounts> {
        const { port, pageSize, selectReady, clock, workerId, queueEngine, diagnostics } = this.dependencies;
        const startedAtMs = clock.nowMs();
        const counts: ALWorkCounts = {
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 0
        };
        await this.finalizeExhaustedWork(counts);
        if (this.shutdown.signal.aborted) {
            return counts;
        }
        const selection = await selectReady(port, pageSize);
        counts.claimedCount = selection.claims.length;
        for (const claim of selection.claims) {
            if (this.shutdown.signal.aborted) {
                return counts;
            }
            await this.runOne(claim, counts);
        }
        queueEngine.wakeAt(workerId, selection.nextReadyAtMs);
        diagnostics?.({
            kind: 'work-batch',
            workerId,
            durationMs: Math.max(0, clock.nowMs() - startedAtMs),
            ...counts
        });
        return counts;
    }

    private async finalizeExhaustedWork(counts: ALWorkCounts): Promise<void> {
        const { port, pageSize } = this.dependencies;
        for (const claim of await port.finalizeExhausted(pageSize)) {
            if (this.shutdown.signal.aborted) {
                return;
            }
            await port.release(claim, { status: 'non-retryable' });
            counts.rejectedCount += 1;
        }
    }

    private async runOne(claim: ALWorkClaim, counts: ALWorkCounts): Promise<void> {
        let result: ALWorkAttemptResult;
        try {
            result = await this.dependencies.runClaim(claim);
        }
        catch (error) {
            result = error instanceof ALAdmissionCorruptionError ||
                    error instanceof NonRetryableException
                ? { status: 'non-retryable' }
                : { status: 'retry' };
        }
        if (result.status === 'retained') {
            // A rejected `settled` only logs here: `release` never runs, so the claim is recovered
            // solely by lease expiry (the port's timeout-reservation path), and it is never added to
            // `counts` on this path or on the eventual release.
            void result.settled
                .then((outcome) => this.dependencies.port.release(claim, outcome))
                .catch((error) => console.error('Retained ALM work failed', error))
                .finally(() => {
                    // This release lands after its batch ended, so it is the one row change no batch
                    // boundary covers: the remembered answer still describes the row as reserved.
                    this.forgetReadiness('retained-release');
                    this.dependencies.queueEngine.wake();
                });
            return;
        }
        await this.dependencies.port.release(claim, result);
        if (result.status === 'completed') {
            counts.completedCount += 1;
        }
        else if (result.status === 'non-retryable') {
            counts.rejectedCount += 1;
        }
        else {
            counts.rescheduledCount += 1;
        }
    }

    private reportBatchFailure(error: Error): void {
        console.error('ALM work batch failed', error);
    }
}
