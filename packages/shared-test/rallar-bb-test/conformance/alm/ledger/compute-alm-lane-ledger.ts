import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '../alm-conformance-scenario-definition.ts';
import type {
    AlmLaneFamilyResult,
    AlmLanePlannedFamily,
    AlmLanePlanRecord
} from '../lane-result/alm-lane-result.ts';

/** The ledger's own reading of a job's conclusion; the reader of GitHub maps GitHub's values onto it. */
export type AlmLaneJobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'in-progress';

export type AlmLaneRunEvent = 'push' | 'pull_request' | 'workflow_dispatch';

/** One job of one workflow run, for one carrier. */
export interface AlmLaneObservedRun {
    readonly runId: number;
    readonly commitSha: string;
    readonly event: AlmLaneRunEvent;
    readonly attempt: number;
    readonly carrier: AlmConformanceCarrier;
    readonly jobConclusion: AlmLaneJobConclusion;
    /** Null when the job uploaded no plan file. */
    readonly plan: AlmLanePlanRecord | null;
    readonly familyResults: readonly AlmLaneFamilyResult[];
}

export interface AlmLaneFlakeCause {
    /** `carrier/family/scenarioKey`, or `carrier/family` for a failure outside any scenario. */
    readonly scenario: string;
    readonly cause: string;
    /** Null while the cause is not fixed. */
    readonly fixedByPullRequest: number | null;
}

export interface AlmLaneRedRun {
    readonly runId: number;
    readonly commitSha: string;
    readonly failed: readonly string[];
    readonly notRun: readonly string[];
}

export interface AlmLaneCarrierStreak {
    readonly carrier: AlmConformanceCarrier;
    /** The counted push runs, newest first, that are green before the first one that is not. */
    readonly streak: number;
    /** Null when no counted push run of the carrier is red. */
    readonly lastRed: AlmLaneRedRun | null;
}

export interface AlmLaneScenarioFailures {
    readonly scenario: string;
    readonly failedRunIds: readonly number[];
    readonly notRunRunIds: readonly number[];
    readonly hasCause: boolean;
}

export interface AlmLaneSideRun {
    readonly runId: number;
    readonly event: Exclude<AlmLaneRunEvent, 'push'>;
    readonly carrier: AlmConformanceCarrier;
    readonly green: boolean;
}

export interface AlmLaneLedger {
    readonly carriers: readonly AlmLaneCarrierStreak[];
    /** Read from push runs only: a pull request's red run may be its own regression, caught as intended. */
    readonly scenarios: readonly AlmLaneScenarioFailures[];
    /** Red push runs that name no scenario or family to blame, such as a job that died before planning. */
    readonly unattributedRedRunIds: readonly number[];
    readonly sideRuns: readonly AlmLaneSideRun[];
}

export interface ComputeAlmLaneLedgerInput {
    /** Newest first. */
    readonly runs: readonly AlmLaneObservedRun[];
    readonly causes: readonly AlmLaneFlakeCause[];
}

/** The scenario keys a run's record failed and did not run. */
interface AlmLaneRunMisses {
    readonly failed: readonly string[];
    readonly notRun: readonly string[];
}

interface AlmLaneReadRun extends AlmLaneRunMisses {
    readonly run: AlmLaneObservedRun;
    readonly green: boolean;
}

export function computeAlmLaneLedger(input: ComputeAlmLaneLedgerInput): AlmLaneLedger {
    const readRuns = input.runs.filter(isReadRun).map(toReadRun);
    const pushRuns = readRuns.filter((read) => read.run.event === 'push');
    const unattributed = pushRuns.filter((read) => !read.green && read.failed.length + read.notRun.length === 0);
    return {
        carriers: ALM_CONFORMANCE_CARRIERS.map((carrier) => computeCarrierStreak(carrier, pushRuns)),
        scenarios: computeScenarioFailures(pushRuns, input.causes),
        unattributedRedRunIds: [...new Set(unattributed.map((read) => read.run.runId))],
        sideRuns: readRuns.flatMap((read) =>
            read.run.event === 'push'
                ? []
                : [{ runId: read.run.runId, event: read.run.event, carrier: read.run.carrier, green: read.green }]
        )
    };
}

/**
 * A job still running or skipped says nothing yet. A cancelled push job is read, since only a person or a dying runner
 * cancels one; a newer push cancels a pull-request or dispatched job by design, so that one is left out.
 */
function isReadRun(run: AlmLaneObservedRun): boolean {
    if (run.jobConclusion === 'in-progress' || run.jobConclusion === 'skipped') {
        return false;
    }
    return run.jobConclusion !== 'cancelled' || run.event === 'push';
}

function toReadRun(run: AlmLaneObservedRun): AlmLaneReadRun {
    const misses = run.plan === null
        ? { failed: [], notRun: [] }
        : computePlanMisses(run.carrier, run.plan, run.familyResults);
    const green = run.attempt === 1 && run.jobConclusion === 'success' && run.plan !== null &&
        misses.failed.length + misses.notRun.length === 0;
    return { run, green, ...misses };
}

/** A result for a family the plan does not name disagrees with the plan, so it fails that family. */
function computePlanMisses(
    carrier: AlmConformanceCarrier,
    plan: AlmLanePlanRecord,
    results: readonly AlmLaneFamilyResult[]
): AlmLaneRunMisses {
    const familyMisses = plan.families.map((planned) =>
        computeFamilyMisses(carrier, planned, results.find((result) => result.family === planned.family))
    );
    const unplanned = results.filter((result) => !plan.families.some((planned) => planned.family === result.family));
    return {
        failed: [
            ...familyMisses.flatMap((misses) => misses.failed),
            ...unplanned.map((result) => toFamilyKey(carrier, result.family))
        ],
        notRun: familyMisses.flatMap((misses) => misses.notRun)
    };
}

/**
 * A family that failed outside its scenarios, or whose result names a scenario its plan does not, is keyed by its
 * carrier and family when no planned scenario of it failed or went unrun.
 */
function computeFamilyMisses(
    carrier: AlmConformanceCarrier,
    planned: AlmLanePlannedFamily,
    result: AlmLaneFamilyResult | undefined
): AlmLaneRunMisses {
    const toScenarioKey = (scenarioKey: string) => `${toFamilyKey(carrier, planned.family)}/${scenarioKey}`;
    const outcomes = new Map(result?.scenarios.map((scenario) => [scenario.scenarioKey, scenario.outcome]));
    const failed = planned.scenarioKeys.filter((key) => outcomes.get(key) === 'failed').map(toScenarioKey);
    const notRun = planned.scenarioKeys.filter((key) => (outcomes.get(key) ?? 'not-run') === 'not-run')
        .map(toScenarioKey);
    const agrees = result === undefined ||
        (result.familyOutcome === 'passed' && [...outcomes.keys()].every((key) => planned.scenarioKeys.includes(key)));
    if (failed.length + notRun.length === 0 && !agrees) {
        return { failed: [toFamilyKey(carrier, planned.family)], notRun };
    }
    return { failed, notRun };
}

function computeCarrierStreak(
    carrier: AlmConformanceCarrier,
    pushRuns: readonly AlmLaneReadRun[]
): AlmLaneCarrierStreak {
    const carrierRuns = pushRuns.filter((read) => read.run.carrier === carrier);
    const firstRedIndex = carrierRuns.findIndex((read) => !read.green);
    const firstRed = carrierRuns[firstRedIndex];
    return {
        carrier,
        streak: firstRed === undefined ? carrierRuns.length : firstRedIndex,
        lastRed: firstRed === undefined
            ? null
            : {
                runId: firstRed.run.runId,
                commitSha: firstRed.run.commitSha,
                failed: firstRed.failed,
                notRun: firstRed.notRun
            }
    };
}

function computeScenarioFailures(
    pushRuns: readonly AlmLaneReadRun[],
    causes: readonly AlmLaneFlakeCause[]
): readonly AlmLaneScenarioFailures[] {
    const scenarios = [...new Set(pushRuns.flatMap((read) => [...read.failed, ...read.notRun]))].sort();
    return scenarios.map((scenario) => ({
        scenario,
        failedRunIds: pushRuns.filter((read) => read.failed.includes(scenario)).map((read) => read.run.runId),
        notRunRunIds: pushRuns.filter((read) => read.notRun.includes(scenario)).map((read) => read.run.runId),
        hasCause: causes.some((cause) => cause.scenario === scenario)
    }));
}

function toFamilyKey(carrier: AlmConformanceCarrier, family: AlmConformanceLaneFamily): string {
    return `${carrier}/${family}`;
}
