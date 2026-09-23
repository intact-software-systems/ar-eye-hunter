import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { toError } from '../../resilience/to-error.ts';
import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, type InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort, ALWorkRelease } from './al-work-queue-port.ts';

export type ALWorkAttemptResult =
    | ALWorkOutcome
    | Readonly<{ status: 'retained'; settled: Promise<ALWorkOutcome>; }>;

export interface ALWorkReadySelection {
    readonly claims: readonly ALWorkClaim[];
    /** A non-negative safe integer (epoch ms) or undefined; `wakeAt` throws `RangeError` on anything else — never clamped here. */
    readonly nextReadyAtMs: number | undefined;
    /** What reading the work and deciding which rows are eligible cost, before the port reserved anything. */
    readonly selectionDurationMs: number;
    /** What the port's reservation of those rows cost. */
    readonly claimDurationMs: number;
    /**
     * The earliest time a claimed row had become **due** -- not when it next becomes claimable. It is
     * read before the reservation that hides it, because a reserved row's own stamps describe its
     * lease. Undefined when nothing was claimed, and for an owner that reserves without observing a
     * page first.
     */
    readonly earliestDueAtMs: number | undefined;
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
    /**
     * Runs one claim. The batch's own start comes with it, so an owner that reports per-claim
     * timing measures the wait against the same moment the batch diagnostics below do.
     */
    readonly runClaim: (claim: ALWorkClaim, batchStartedAtMs: number) => Promise<ALWorkAttemptResult>;
    readonly diagnostics: ((event: ALWorkDiagnostics) => void) | undefined;
}

export type ALWorkDiagnostics = ALWorkBatchDiagnostics | ALWorkReadinessProbeDiagnostics;

/**
 * What one batch did and where its time went. The four phases never sum to `durationMs`: the
 * exhaustion sweep's own read, and a page the readiness probe already paid for, are outside them,
 * and `readiness-probe` carries that read. `queueWaitMs` is not a phase at all -- it is time the
 * batch never spent, and the only field here that separates a backlog from a slow drain.
 */
export interface ALWorkBatchDiagnostics {
    readonly kind: 'work-batch';
    readonly workerId: string;
    readonly durationMs: number;
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly rescheduledCount: number;
    readonly rejectedCount: number;
    /** The selection's own read, as the owner measured it; zero for an owner that reserves without one. */
    readonly selectionDurationMs: number;
    /** The port's reservation of the selected rows. */
    readonly claimDurationMs: number;
    /** Every claim's own work, summed. A retained claim contributes only the part that ran in the batch. */
    readonly runDurationMs: number;
    /** The one flush that released this batch, the exhaustion sweep's claims included. A retained claim releases after the batch and contributes nothing. */
    readonly releaseDurationMs: number;
    /** How long the earliest claimed row had been due when the batch started; zero when it claimed none. */
    readonly queueWaitMs: number;
    /** The instant every claim of this batch receives as `batchStartedAtMs`. */
    readonly startedAtMs: number;
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
    /** What that storage read cost. An owner whose probe holds the page its batch then claims from spends the batch's page read here. */
    readonly durationMs: number;
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

/** What a running batch has accumulated: its outcome counts and the two phases the handler itself times. */
interface ALWorkBatchProgress extends ALWorkCounts {
    runDurationMs: number;
    releaseDurationMs: number;
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
        const probedAtMs = this.dependencies.clock.nowMs();
        const readyAtMs = await this.dependencies.readNextReadyAtMs(this.dependencies.port);
        if (generation === this.readinessGeneration) {
            this.readiness = { readyAtMs, observedAtMs: nowMs };
        }
        this.dependencies.diagnostics?.({
            kind: 'readiness-probe',
            workerId: this.dependencies.workerId,
            cause,
            readyAtMs: readyAtMs ?? 'none',
            durationMs: computeElapsedMs(probedAtMs, this.dependencies.clock.nowMs())
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

    private async runSelectedWork(): Promise<ALWorkBatchProgress> {
        const { clock, workerId, queueEngine } = this.dependencies;
        const startedAtMs = clock.nowMs();
        const progress: ALWorkBatchProgress = {
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 0,
            runDurationMs: 0,
            releaseDurationMs: 0
        };
        const releases: ALWorkRelease[] = [...await this.finalizeExhaustedWork(progress)];
        let selection: ALWorkReadySelection | undefined;
        try {
            if (!this.shutdown.signal.aborted) {
                selection = await this.runClaimedWork(releases, startedAtMs, progress);
            }
        }
        finally {
            // The sweep's finalizations are reserved rows already: a selection or a claim that
            // throws must not leave them waiting for their leases to expire.
            await this.flushReleases(releases, progress);
        }
        if (selection === undefined) {
            return progress;
        }
        queueEngine.wakeAt(workerId, selection.nextReadyAtMs);
        this.reportBatch(selection, startedAtMs, progress);
        return progress;
    }

    /**
     * The selection this batch claimed from, or nothing once disposal ended the batch mid-claim,
     * which leaves the wake and the diagnostics to whichever batch resumes.
     */
    private async runClaimedWork(
        releases: ALWorkRelease[],
        batchStartedAtMs: number,
        progress: ALWorkBatchProgress
    ): Promise<ALWorkReadySelection | undefined> {
        const { port, pageSize, selectReady } = this.dependencies;
        const selection = await selectReady(port, pageSize);
        progress.claimedCount = selection.claims.length;
        for (const claim of selection.claims) {
            if (this.shutdown.signal.aborted) {
                return undefined;
            }
            const release = await this.runOne(claim, batchStartedAtMs, progress);
            if (release !== undefined) {
                releases.push(release);
            }
        }
        return selection;
    }

    private reportBatch(
        selection: ALWorkReadySelection,
        startedAtMs: number,
        progress: ALWorkBatchProgress
    ): void {
        const { clock, workerId, diagnostics } = this.dependencies;
        diagnostics?.({
            kind: 'work-batch',
            workerId,
            durationMs: computeElapsedMs(startedAtMs, clock.nowMs()),
            ...progress,
            selectionDurationMs: selection.selectionDurationMs,
            claimDurationMs: selection.claimDurationMs,
            queueWaitMs: computeALWorkQueueWaitMs(selection.earliestDueAtMs, startedAtMs),
            startedAtMs
        });
    }

    private async finalizeExhaustedWork(
        progress: ALWorkBatchProgress
    ): Promise<readonly ALWorkRelease[]> {
        const { port, pageSize } = this.dependencies;
        const releases: ALWorkRelease[] = [];
        for (const claim of await port.finalizeExhausted(pageSize)) {
            if (this.shutdown.signal.aborted) {
                return releases;
            }
            releases.push({ claim, outcome: { status: 'non-retryable' } });
            progress.rejectedCount += 1;
        }
        return releases;
    }

    /** The release the batch's flush owes this claim, or nothing at all for a retained one. */
    private async runOne(
        claim: ALWorkClaim,
        batchStartedAtMs: number,
        progress: ALWorkBatchProgress
    ): Promise<ALWorkRelease | undefined> {
        const { clock, runClaim } = this.dependencies;
        const runStartedAtMs = clock.nowMs();
        let result: ALWorkAttemptResult;
        try {
            result = await runClaim(claim, batchStartedAtMs);
        }
        catch (error) {
            result = toALWorkFailureOutcome(toError(error));
        }
        progress.runDurationMs += computeElapsedMs(runStartedAtMs, clock.nowMs());
        if (result.status === 'retained') {
            this.releaseRetainedClaim(claim, result.settled);
            return undefined;
        }
        if (result.status === 'completed') {
            progress.completedCount += 1;
        }
        else if (result.status === 'non-retryable') {
            progress.rejectedCount += 1;
        }
        else {
            progress.rescheduledCount += 1;
        }
        return { claim, outcome: result };
    }

    private async flushReleases(
        releases: readonly ALWorkRelease[],
        progress: ALWorkBatchProgress
    ): Promise<void> {
        const { clock, port } = this.dependencies;
        const startedAtMs = clock.nowMs();
        await port.releaseAll(releases);
        progress.releaseDurationMs = computeElapsedMs(startedAtMs, clock.nowMs());
    }

    /**
     * A rejected `settled` only logs here: the release never runs, so the claim is recovered solely by
     * lease expiry (the port's timeout-reservation path), and it is never added to the batch's counts
     * on this path or on the eventual release.
     */
    private releaseRetainedClaim(claim: ALWorkClaim, settled: Promise<ALWorkOutcome>): void {
        void settled
            .then((outcome) => this.dependencies.port.releaseAll([{ claim, outcome }]))
            .catch((error) => console.error('Retained ALM work failed', error))
            .finally(() => {
                // This release lands after its batch ended, so it is the one row change no batch
                // boundary covers: the remembered answer still describes the row as reserved.
                this.forgetReadiness('retained-release');
                this.dependencies.queueEngine.wake();
            });
    }

    private reportBatchFailure(error: Error): void {
        console.error('ALM work batch failed', error);
    }
}

/** A clock that steps backwards under a system time change must never report a negative phase. */
function computeElapsedMs(startedAtMs: number, endedAtMs: number): number {
    return Math.max(0, endedAtMs - startedAtMs);
}

/** A batch that claimed nothing waited on nothing, so it reports no wait rather than a made-up one. */
function computeALWorkQueueWaitMs(
    earliestDueAtMs: number | undefined,
    batchStartedAtMs: number
): number {
    return earliestDueAtMs === undefined ? 0 : computeElapsedMs(earliestDueAtMs, batchStartedAtMs);
}

/** The one place a thrown claim becomes an outcome; the caught value is normalized before it. */
function toALWorkFailureOutcome(error: Error): ALWorkOutcome {
    return error instanceof ALAdmissionCorruptionError || error instanceof NonRetryableException
        ? { status: 'non-retryable' }
        : { status: 'retry' };
}
