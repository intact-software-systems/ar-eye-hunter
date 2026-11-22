import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '../alm-conformance-scenario-definition.ts';
import type {
    AlmLaneFamilyResult,
    AlmLanePlannedFamily,
    AlmLanePlanRecord
} from '../lane-result/alm-lane-result.ts';

/**
 * The ledger's own reading of a job's conclusion; the reader of GitHub maps GitHub's values onto it. `not-read` is a
 * carrier of a completed run for which no job could be read at all.
 */
export type AlmLaneJobConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'in-progress' | 'not-read';

export type AlmLaneRunEvent = 'push' | 'pull_request' | 'workflow_dispatch';

/** Why a red run names no key to blame. */
export type AlmLaneUnattributedReason =
    | 'rerun'
    | 'job-not-success'
    | 'no-plan'
    | 'cancelled'
    | 'no-job-read'
    | 'plan-plans-nothing';

/** A carrier's jobs in one workflow run, read as one run. */
export interface AlmLaneObservedRun {
    readonly runId: number;
    readonly commitSha: string;
    readonly event: AlmLaneRunEvent;
    readonly attempt: number;
    readonly carrier: AlmConformanceCarrier;
    readonly jobConclusion: AlmLaneJobConclusion;
    /** Null when no job of the carrier uploaded a readable plan, or a job's artifact is missing or unread. */
    readonly plan: AlmLanePlanRecord | null;
    readonly familyResults: readonly AlmLaneFamilyResult[];
}

export interface AlmLaneRunReading {
    readonly run: AlmLaneObservedRun;
    readonly green: boolean;
    /** False when the run has no plan, or its plan is for another carrier. */
    readonly planRead: boolean;
    /** Keys a scenario or family failed: `carrier/family/scenarioKey`, or `carrier/family` outside every scenario. */
    readonly failed: readonly string[];
    readonly notRun: readonly string[];
    /**
     * The keys that answer for the run's failures: every failed key; a family's own key when the family is not green
     * and no key of it failed; and `carrier/run/<run id>` for a red run that names no key.
     */
    readonly candidates: readonly string[];
    /** Set exactly when the run is red and names no key. */
    readonly unattributedReason: AlmLaneUnattributedReason | null;
}

interface ComputeFamilyReadingInput {
    readonly carrier: AlmConformanceCarrier;
    readonly planned: AlmLanePlannedFamily;
    /** The family's first result for the run's carrier. */
    readonly result: AlmLaneFamilyResult | undefined;
    /** True when a result for the family was refused: a second one, or one for another carrier. */
    readonly refused: boolean;
}

interface AlmLaneFamilyReading {
    readonly familyKey: string;
    readonly green: boolean;
    readonly failed: readonly string[];
    readonly notRun: readonly string[];
}

/** A plan for another carrier says nothing about this run, which is then read as having no plan. */
export function computeAlmLaneRunReading(run: AlmLaneObservedRun): AlmLaneRunReading {
    const plan = run.plan?.carrier === run.carrier ? run.plan : null;
    const families = plan === null ? [] : computeFamilyReadings(run.carrier, plan, run.familyResults);
    const failed = [...new Set(families.flatMap((family) => family.failed))];
    const notRun = families.flatMap((family) => family.notRun);
    const plansScenarios = plan?.families.some((planned) => planned.scenarioKeys.length > 0) ?? false;
    const green = run.attempt === 1 && run.jobConclusion === 'success' && plansScenarios &&
        families.every((family) => family.green);
    const unattributedReason = green || failed.length + notRun.length > 0
        ? null
        : resolveUnattributedReason(run, plan);
    const familyCandidates = families.flatMap((family) =>
        family.green ? [] : family.failed.length > 0 ? family.failed : [family.familyKey]
    );
    return {
        run,
        green,
        planRead: plan !== null,
        failed,
        notRun,
        candidates: unattributedReason === null
            ? [...new Set(familyCandidates)]
            : [`${run.carrier}/run/${run.runId}`],
        unattributedReason
    };
}

function resolveUnattributedReason(
    run: AlmLaneObservedRun,
    plan: AlmLanePlanRecord | null
): AlmLaneUnattributedReason {
    if (run.jobConclusion === 'not-read') {
        return 'no-job-read';
    }
    if (run.attempt > 1) {
        return 'rerun';
    }
    if (run.jobConclusion === 'cancelled') {
        return 'cancelled';
    }
    if (plan === null) {
        return 'no-plan';
    }
    return plan.families.some((planned) => planned.scenarioKeys.length > 0) ? 'job-not-success' : 'plan-plans-nothing';
}

/**
 * One reading per planned family, and one red reading per result the plan cannot vouch for: a result for a family the
 * plan does not name, one for another carrier, and a second result for the same family.
 */
function computeFamilyReadings(
    carrier: AlmConformanceCarrier,
    plan: AlmLanePlanRecord,
    results: readonly AlmLaneFamilyResult[]
): readonly AlmLaneFamilyReading[] {
    const resolveFirstResult = (family: AlmConformanceLaneFamily) =>
        results.find((result) => result.carrier === carrier && result.family === family);
    const refused = results.filter((result) =>
        resolveFirstResult(result.family) !== result ||
        !plan.families.some((planned) => planned.family === result.family)
    );
    const refusedFamilies = new Set(refused.map((result) => result.family));
    const planned = plan.families.map((family) =>
        computeFamilyReading({
            carrier,
            planned: family,
            result: resolveFirstResult(family.family),
            refused: refusedFamilies.has(family.family)
        })
    );
    const unplanned = [...refusedFamilies].filter((family) => !plan.families.some((entry) => entry.family === family))
        .map((family): AlmLaneFamilyReading => {
            const familyKey = toFamilyKey(carrier, family);
            return { familyKey, green: false, failed: [familyKey], notRun: [] };
        });
    return [...planned, ...unplanned];
}

/**
 * A family that failed outside its scenarios, whose result names a scenario its plan does not, or whose result was
 * refused, is keyed by its carrier and family when no planned scenario of it failed or went unrun.
 */
function computeFamilyReading(input: ComputeFamilyReadingInput): AlmLaneFamilyReading {
    const { carrier, planned, result, refused } = input;
    const familyKey = toFamilyKey(carrier, planned.family);
    const outcomes = new Map(result?.scenarios.map((scenario) => [scenario.scenarioKey, scenario.outcome]));
    const failed = planned.scenarioKeys.filter((key) => outcomes.get(key) === 'failed')
        .map((key) => `${familyKey}/${key}`);
    const notRun = planned.scenarioKeys.filter((key) => (outcomes.get(key) ?? 'not-run') === 'not-run')
        .map((key) => `${familyKey}/${key}`);
    const agrees = !refused && (result === undefined ||
        (result.familyOutcome === 'passed' && [...outcomes.keys()].every((key) => planned.scenarioKeys.includes(key))));
    const green = agrees && failed.length + notRun.length === 0;
    const familyFailed = !agrees && (failed.length + notRun.length === 0 || refused) ? [familyKey] : [];
    return { familyKey, green, failed: [...failed, ...familyFailed], notRun };
}

function toFamilyKey(carrier: AlmConformanceCarrier, family: AlmConformanceLaneFamily): string {
    return `${carrier}/${family}`;
}
