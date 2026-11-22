import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    computeAlmLaneRunReading,
    type AlmLaneJobConclusion,
    type AlmLaneObservedRun,
    type AlmLaneRunEvent,
    type AlmLaneRunReading,
    type AlmLaneUnattributedReason
} from './compute-alm-lane-run-reading.ts';

export interface AlmLaneFlakeCause {
    /** `carrier/family/scenarioKey`, `carrier/family` for a failure outside any scenario, or `carrier/run/<run id>`. */
    readonly key: string;
    readonly cause: string;
    /** Null while the cause is not fixed. */
    readonly fixedByPullRequest: number | null;
}

export interface AlmLaneRedRun {
    readonly runId: number;
    readonly commitSha: string;
    readonly attempt: number;
    readonly jobConclusion: AlmLaneJobConclusion;
    readonly planRead: boolean;
    /** Set when the run names no key. */
    readonly reason: AlmLaneUnattributedReason | null;
    readonly failed: readonly string[];
    readonly notRun: readonly string[];
}

export interface AlmLaneUnattributedRun {
    readonly runId: number;
    readonly commitSha: string;
    readonly reason: AlmLaneUnattributedReason;
}

export interface AlmLaneCarrierStreak {
    readonly carrier: AlmConformanceCarrier;
    /** The counted push runs, newest first, that are green before the first one that is not. */
    readonly streak: number;
    /** How many counted push runs of the carrier were read. */
    readonly runsRead: number;
    /** Null when no counted push run of the carrier is red. */
    readonly lastRed: AlmLaneRedRun | null;
    /** The carrier's red push runs that name no key, newest first. */
    readonly unattributed: readonly AlmLaneUnattributedRun[];
    /** The failures of the carrier's push runs with no recorded cause, by key; sorted. */
    readonly uncaused: readonly string[];
}

export interface AlmLaneKeyFailures {
    readonly key: string;
    readonly failedRunIds: readonly number[];
    readonly notRunRunIds: readonly number[];
    readonly cause: AlmLaneFlakeCause | null;
}

export interface AlmLaneSideRun {
    readonly runId: number;
    readonly event: Exclude<AlmLaneRunEvent, 'push'>;
    readonly carrier: AlmConformanceCarrier;
    readonly green: boolean;
}

/** A carrier's run the ledger does not read: still running, skipped, or a cancelled pull-request run. */
export interface AlmLaneLeftOutRun {
    readonly runId: number;
    readonly event: AlmLaneRunEvent;
    readonly carrier: AlmConformanceCarrier;
    readonly jobConclusion: AlmLaneJobConclusion;
}

export interface AlmLaneLedger {
    readonly carriers: readonly AlmLaneCarrierStreak[];
    /** Read from push runs only: a pull request's red run may be its own regression, caught as intended. */
    readonly keys: readonly AlmLaneKeyFailures[];
    readonly sideRuns: readonly AlmLaneSideRun[];
    readonly leftOutRuns: readonly AlmLaneLeftOutRun[];
}

export interface ComputeAlmLaneLedgerInput {
    /** Newest first. */
    readonly runs: readonly AlmLaneObservedRun[];
    readonly causes: readonly AlmLaneFlakeCause[];
}

export function computeAlmLaneLedger(input: ComputeAlmLaneLedgerInput): AlmLaneLedger {
    const readings = input.runs.filter(isReadRun).map(computeAlmLaneRunReading);
    const pushReadings = readings.filter((reading) => reading.run.event === 'push');
    return {
        carriers: ALM_CONFORMANCE_CARRIERS.map((carrier) => computeCarrierStreak(carrier, pushReadings, input.causes)),
        keys: computeKeyFailures(pushReadings, input.causes),
        sideRuns: readings.flatMap(({ run, green }) =>
            run.event === 'push' ? [] : [{ runId: run.runId, event: run.event, carrier: run.carrier, green }]
        ),
        leftOutRuns: input.runs.filter((run) => !isReadRun(run)).map(({ runId, event, carrier, jobConclusion }) => ({
            runId,
            event,
            carrier,
            jobConclusion
        }))
    };
}

/**
 * A carrier whose jobs are still running or skipped says nothing yet. A newer push to a pull request cancels its jobs
 * by design, so that run is left out; a push or dispatched run has a concurrency group of its own, so a cancelled one
 * is read.
 */
function isReadRun(run: AlmLaneObservedRun): boolean {
    if (run.jobConclusion === 'in-progress' || run.jobConclusion === 'skipped') {
        return false;
    }
    return run.jobConclusion !== 'cancelled' || run.event !== 'pull_request';
}

function computeCarrierStreak(
    carrier: AlmConformanceCarrier,
    pushReadings: readonly AlmLaneRunReading[],
    causes: readonly AlmLaneFlakeCause[]
): AlmLaneCarrierStreak {
    const carrierReadings = pushReadings.filter((reading) => reading.run.carrier === carrier);
    const firstRedIndex = carrierReadings.findIndex((reading) => !reading.green);
    const firstRed = carrierReadings[firstRedIndex];
    const candidates = new Set(carrierReadings.flatMap((reading) => reading.candidates));
    return {
        carrier,
        streak: firstRed === undefined ? carrierReadings.length : firstRedIndex,
        runsRead: carrierReadings.length,
        lastRed: firstRed === undefined ? null : toRedRun(firstRed),
        unattributed: carrierReadings.flatMap(({ run, unattributedReason }) =>
            unattributedReason === null
                ? []
                : [{ runId: run.runId, commitSha: run.commitSha, reason: unattributedReason }]
        ),
        uncaused: [...candidates].filter((key) => resolveCause(causes, key) === null).sort()
    };
}

function toRedRun(reading: AlmLaneRunReading): AlmLaneRedRun {
    return {
        runId: reading.run.runId,
        commitSha: reading.run.commitSha,
        attempt: reading.run.attempt,
        jobConclusion: reading.run.jobConclusion,
        planRead: reading.planRead,
        reason: reading.unattributedReason,
        failed: reading.failed,
        notRun: reading.notRun
    };
}

function computeKeyFailures(
    pushReadings: readonly AlmLaneRunReading[],
    causes: readonly AlmLaneFlakeCause[]
): readonly AlmLaneKeyFailures[] {
    const keys = [...new Set(pushReadings.flatMap((reading) => [...reading.failed, ...reading.notRun]))].sort();
    return keys.map((key) => ({
        key,
        failedRunIds: pushReadings.filter((reading) => reading.failed.includes(key)).map(({ run }) => run.runId),
        notRunRunIds: pushReadings.filter((reading) => reading.notRun.includes(key)).map(({ run }) => run.runId),
        cause: resolveCause(causes, key)
    }));
}

function resolveCause(causes: readonly AlmLaneFlakeCause[], key: string): AlmLaneFlakeCause | null {
    return causes.find((cause) => cause.key === key) ?? null;
}
