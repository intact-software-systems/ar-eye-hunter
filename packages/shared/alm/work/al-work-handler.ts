import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { toKeyAsString } from '../../queuebox/ResourceEntry.ts';
import { toError } from '../../resilience/to-error.ts';
import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, type InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALStorageHealth } from '../storage/al-storage-health.ts';
import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
import type { ALDurableWorkLaneOwnership } from './al-durable-work-ownership.ts';
import type { ALWorkBatchObservations } from './al-work-batch-observations.ts';
import { ALWorkEngineMembership } from './al-work-engine-membership.ts';
import type {
    ALWorkClaim,
    ALWorkOutcome,
    ALWorkQueuePort,
    ALWorkRelease
} from './al-work-queue-port.ts';
import {
    ALWorkReadinessMemory,
    type ALWorkCommittedRows,
    type ALWorkReadinessAnswer,
    type ALWorkReadinessProbeCause
} from './al-work-readiness-memory.ts';

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

/** Per-batch private evidence, delivered after the handler's mandatory lifecycle; never a release receipt. */
export type ALWorkObservationDeferral = (publish: () => void) => void;

export interface ALWorkHandlerDependencies {
    readonly batchObservations?: typeof ALWorkBatchObservations;

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
     * Reserves the claim a completed one hands its place in the batch to, which the batch then runs
     * after the claims it selected. Asked only after a claim completed and while the batch has
     * fewer than `pageSize` claims, so a claim that failed promotes nothing and no batch runs more
     * than a page. Undefined for an owner whose rows wait on no other row of theirs.
     */
    readonly claimSuccessor:
        | ((port: ALWorkQueuePort, completed: ALWorkClaim) => Promise<ALWorkClaim | undefined>)
        | undefined;
    /**
     * Runs one claim. The instant the batch's run loop started comes with it -- after the selection
     * and the reservation, before the first claim runs -- so an owner that reports per-claim timing
     * measures the wait behind earlier claims against the same moment the batch diagnostics do. A
     * claim that may commit this owner's work rows calls `ALWorkHandler.claimCommitted()` before it
     * runs, or the batch's end could restore an answer that misses those rows.
     */
    readonly runClaim: (
        claim: ALWorkClaim,
        batchStartedAtMs: number,
        deferObservation?: ALWorkObservationDeferral
    ) => Promise<ALWorkAttemptResult>;
    readonly diagnostics: ((event: ALWorkDiagnostics) => void) | undefined;
    /**
     * Absent on the server lane and on the browser's memory lanes, which have no storage health
     * reporter, so their batch failures are logged; the browser's durable lanes pass it.
     */
    readonly storageHealth?: ALStorageHealth;
    /**
     * The session ownership a durable lane's work runs under. While another runtime owns it, this
     * handler joins no engine round, runs no batch and announces its commits instead. Absent on a lane
     * no other runtime drains (the server's, a memory lane's), which owns its work from construction.
     */
    readonly durableOwnership?: ALDurableWorkLaneOwnership;
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
    /**
     * The instant the run loop started, after the selection and the reservation: what every claim of
     * this batch receives as `batchStartedAtMs`. `durationMs` and `queueWaitMs` run from the batch's
     * own earlier start.
     */
    readonly startedAtMs: number;
}

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
 * How long one probe's answer stands, counted from that probe whatever batches ran since. It is the
 * engine's own idle ceiling, derived from it so the two cannot drift apart: work another tab wrote
 * unannounced, or a row a crashed owner's lease still holds, is discovered on that idle cadence instead of
 * costing a storage read on every engine round.
 */
export const AL_WORK_READINESS_MEMORY_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS;

/**
 * The bound an owner passes when every engine round must reach its probe. An owner whose probe
 * carries scan state of its own -- the inbound rotation, where "nothing here" means nothing at this
 * scan position -- has no answer that can stand for any length of time.
 */
export const AL_WORK_PROBE_EVERY_ROUND = 0;

interface ALWorkCounts {
    claimedCount: number;
    completedCount: number;
    rescheduledCount: number;
    rejectedCount: number;
}

/** The selection a batch claimed from, and the instant its run loop started over those claims. */
interface ALWorkClaimedRun {
    readonly selection: ALWorkReadySelection;
    readonly runStartedAtMs: number;
    readonly deferObservation: ALWorkObservationDeferral | undefined;
}

/** What a running batch has accumulated: its outcome counts and the two phases the handler itself times. */
interface ALWorkBatchProgress extends ALWorkCounts {
    runDurationMs: number;
    releaseDurationMs: number;
}

/** A batch that flushed its releases: what it counted, and its run unless disposal cut the claims short. */
interface ALWorkBatchEnd {
    readonly progress: ALWorkBatchProgress;
    readonly run: ALWorkClaimedRun | undefined;
    readonly startedAtMs: number;
    /** The queue key of every claim the batch completed. */
    readonly completedKeys: ReadonlySet<string>;
}

/**
 * Generic ALM work loop: the port owns reservation and retry policy, this owns the engine task and
 * the batch lifecycle, and `ALWorkReadinessMemory` owns how long a probe's answer stands.
 */
export class ALWorkHandler {
    private readonly dependencies: ALWorkHandlerDependencies;
    private batch: Promise<void> | undefined;
    private bootstrapped = false;
    private readonly readiness: ALWorkReadinessMemory;
    /** Set when committed() lands while a batch is running; drained by one follow-up batch at that batch's end. */
    private commitPending = false;
    private readonly shutdown = new AbortController();
    private readonly engine: ALWorkEngineMembership;

    constructor(dependencies: ALWorkHandlerDependencies) {
        this.dependencies = dependencies;
        this.readiness = new ALWorkReadinessMemory(dependencies.readinessMemoryMs);
        this.engine = new ALWorkEngineMembership({
            queueEngine: dependencies.queueEngine,
            workerId: dependencies.workerId,
            task: {
                name: dependencies.workerId,
                maxConcurrency: () => 1,
                isWork: () => this.hasReadyWork(),
                runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
                ongoingTasks: []
            },
            // Only the server announces a write this engine did not make; another tab's commit reaches
            // the owner's lane as its own, and a row a reload wrote is found at the age bound.
            onExternalWake: () => this.readiness.forget('external-wake'),
            durableOwnership: dependencies.durableOwnership,
            takeOver: () => void this.ready().catch((error) => this.reportBatchFailure(toError(error)))
        });
    }

    async ready(): Promise<void> {
        if (this.bootstrapped || this.shutdown.signal.aborted || !this.engine.isOwned()) {
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
        this.engine.dispose();
        if (this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.stop();
        }
    }

    /**
     * After a commit: wakes the engine and runs one batch if idle; never blocks on delivery of
     * unrelated work. It is also the invalidation an owner owes for any write of its own rows it
     * made outside `runBatch`. `written` says when the last row the commit wrote becomes claimable
     * and which rows it wrote: only a batch that starts at or after then, and completes a claim of
     * each, can have claimed every one of them. While another runtime owns the work, the commit is
     * announced to that owner and runs nothing here.
     */
    committed(written: ALWorkCommittedRows): void {
        if (this.engine.announceUnlessOwned(written)) {
            return;
        }
        this.readiness.suspend(written);
        this.dependencies.queueEngine.wake();
        if (this.batch === undefined) {
            void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
        }
        else {
            this.commitPending = true;
        }
    }

    /**
     * Called before a claim of the running batch that may commit work rows of this owner: the batch's
     * end restores no answer and the next round probes, as after any batch. It starts no batch of its
     * own: the running batch's end wakes the engine.
     */
    claimCommitted(): void {
        this.readiness.forget('batch');
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
     * arrives without reading anything; a remembered "no work" stands until an invalidation empties it
     * or the memory ages out.
     */
    private async readReadyAtMs(nowMs: number): Promise<number | undefined> {
        const { clock, diagnostics, port, readNextReadyAtMs, workerId } = this.dependencies;
        const standing = this.readiness.getStandingAnswer(nowMs);
        if (standing !== undefined) {
            return standing.readyAtMs;
        }
        const probedAtMs = clock.nowMs();
        const probe = await this.readiness.readProbe(nowMs, () => readNextReadyAtMs(port));
        diagnostics?.({
            kind: 'readiness-probe',
            workerId,
            cause: probe.cause,
            readyAtMs: probe.readyAtMs ?? 'none',
            durationMs: computeElapsedMs(probedAtMs, clock.nowMs())
        });
        return probe.readyAtMs;
    }

    /**
     * The batch's end settles the readiness memory: a commit and a batch both change the rows a probe
     * read, so the answer is dropped unless the batch restores the one its commit set aside. The other
     * ways a change reaches the memory are `committed()`, `claimCommitted()`, a retained claim's
     * settlement, and the engine wake every writer that is not this owner announces its row with.
     */
    private settleReadiness(ended: ALWorkBatchEnd): ALWorkReadinessAnswer | undefined {
        if (ended.run === undefined) {
            return this.readiness.settle(undefined);
        }
        const { claimedCount, completedCount, rejectedCount } = ended.progress;
        return this.readiness.settle({
            claimedCount,
            completedCount,
            rejectedCount,
            completedKeys: ended.completedKeys,
            pageSize: this.dependencies.pageSize,
            startedAtMs: ended.startedAtMs,
            commitPending: this.commitPending
        });
    }

    private runBatch(): Promise<void> {
        if (this.shutdown.signal.aborted) {
            return Promise.resolve();
        }
        if (this.batch !== undefined) {
            return this.batch;
        }
        const observations = this.dependencies.batchObservations?.tryCreate();
        const deferObservation = this.dependencies.batchObservations === undefined
            ? undefined
            : observations?.defer ?? this.dependencies.batchObservations.discard;
        this.batch = this.runSelectedWork(deferObservation)
            .then((ended) => this.endBatch(ended))
            .catch((error) => this.failBatch(toError(error)))
            .finally(() => {
                this.batch = undefined;
                try {
                    this.runPendingCommit();
                }
                finally {
                    observations?.publish();
                }
            });
        return this.batch;
    }

    private endBatch(ended: ALWorkBatchEnd): void {
        const restored = this.settleReadiness(ended);
        if (ended.run !== undefined) {
            const { queueEngine, workerId } = this.dependencies;
            queueEngine.wakeAt(workerId, ended.run.selection.nextReadyAtMs ?? restored?.readyAtMs);
        }
        this.wakeAfterProgress(ended.progress);
    }

    private failBatch(error: Error): void {
        this.readiness.settle(undefined);
        if (error instanceof ALAdmissionCorruptionError) {
            throw error;
        }
        this.reportBatchFailure(error);
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

    private async runSelectedWork(deferObservation: ALWorkObservationDeferral | undefined): Promise<ALWorkBatchEnd> {
        const { clock } = this.dependencies;
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
        let run: ALWorkClaimedRun | undefined;
        try {
            if (!this.shutdown.signal.aborted) {
                run = await this.runClaimedWork(releases, progress, deferObservation);
            }
        }
        finally {
            // The sweep's finalizations are reserved rows already: a selection or a claim that
            // throws must not leave them waiting for their leases to expire.
            await this.flushReleases(releases, progress);
        }
        if (run !== undefined) {
            this.reportBatch(run, startedAtMs, progress);
        }
        return { progress, run, startedAtMs, completedKeys: toALWorkCompletedKeys(releases) };
    }

    /**
     * The selection this batch claimed from and the instant its run loop started, or nothing once
     * disposal ended the batch mid-claim, which leaves the wake and the diagnostics to whichever batch
     * resumes.
     */
    private async runClaimedWork(
        releases: ALWorkRelease[],
        progress: ALWorkBatchProgress,
        deferObservation: ALWorkObservationDeferral | undefined
    ): Promise<ALWorkClaimedRun | undefined> {
        const { clock, port, pageSize, selectReady } = this.dependencies;
        const selection = await selectReady(port, pageSize);
        const queued = [...selection.claims];
        progress.claimedCount = queued.length;
        const runStartedAtMs = clock.nowMs();
        const run = { selection, runStartedAtMs, deferObservation };
        for (let claim = queued.shift(); claim !== undefined; claim = queued.shift()) {
            if (this.shutdown.signal.aborted) {
                return undefined;
            }
            const release = await this.runOne(claim, progress, run);
            if (release === undefined) {
                continue;
            }
            releases.push(release);
            const successors = await this.claimSuccessors(release, progress.claimedCount);
            queued.push(...successors);
            progress.claimedCount += successors.length;
        }
        return run;
    }

    /**
     * The successor a completed claim hands its place to, while the batch holds fewer than a page.
     * One that cannot be claimed is left to the next selection, and the failure is stated as a batch
     * failure is: throwing here would strand the claims this batch has not run yet.
     */
    private async claimSuccessors(release: ALWorkRelease, claimedCount: number): Promise<readonly ALWorkClaim[]> {
        const { claimSuccessor, pageSize, port } = this.dependencies;
        if (claimSuccessor === undefined || release.outcome.status !== 'completed' || claimedCount >= pageSize) {
            return [];
        }
        try {
            const successor = await claimSuccessor(port, release.claim);
            return successor === undefined ? [] : [successor];
        }
        catch (error) {
            this.reportBatchFailure(toError(error));
            return [];
        }
    }

    private reportBatch(
        run: ALWorkClaimedRun,
        startedAtMs: number,
        progress: ALWorkBatchProgress
    ): void {
        const { selection, runStartedAtMs } = run;
        const { clock, workerId, diagnostics } = this.dependencies;
        diagnostics?.({
            kind: 'work-batch',
            workerId,
            durationMs: computeElapsedMs(startedAtMs, clock.nowMs()),
            ...progress,
            selectionDurationMs: selection.selectionDurationMs,
            claimDurationMs: selection.claimDurationMs,
            queueWaitMs: computeALWorkQueueWaitMs(selection.earliestDueAtMs, startedAtMs),
            startedAtMs: runStartedAtMs
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
        progress: ALWorkBatchProgress,
        run: ALWorkClaimedRun
    ): Promise<ALWorkRelease | undefined> {
        const { clock, runClaim } = this.dependencies;
        const runStartedAtMs = clock.nowMs();
        let result: ALWorkAttemptResult;
        try {
            result = await runClaim(claim, run.runStartedAtMs, run.deferObservation);
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
        const { clock, port, storageHealth } = this.dependencies;
        const startedAtMs = clock.nowMs();
        await port.releaseAll(releases);
        const endedAtMs = clock.nowMs();
        progress.releaseDurationMs = computeElapsedMs(startedAtMs, endedAtMs);
        if (releases.length > 0) {
            storageHealth?.recordRecoveryPoint(endedAtMs);
        }
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
                this.readiness.forget('retained-release');
                this.dependencies.queueEngine.wake();
            });
    }

    /** A storage failure wrote nothing, so its rows wait for the next batch; the store's health states it. */
    private reportBatchFailure(error: Error): void {
        const unavailable = toALStorageUnavailable(error);
        const { storageHealth } = this.dependencies;
        if (unavailable === undefined || storageHealth === undefined) {
            console.error('ALM work batch failed', error);
            return;
        }
        storageHealth.recordFailure(unavailable);
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

function toALWorkCompletedKeys(releases: readonly ALWorkRelease[]): ReadonlySet<string> {
    return new Set(
        releases
            .filter((release) => release.outcome.status === 'completed')
            .map((release) => toKeyAsString(release.claim.entry.key))
    );
}

/** The one place a thrown claim becomes an outcome; the caught value is normalized before it. */
function toALWorkFailureOutcome(error: Error): ALWorkOutcome {
    return error instanceof ALAdmissionCorruptionError || error instanceof NonRetryableException
        ? { status: 'non-retryable' }
        : { status: 'retry' };
}
