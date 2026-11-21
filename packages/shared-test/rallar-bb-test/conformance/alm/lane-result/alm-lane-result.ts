import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily, AlmConformanceTag } from '../alm-conformance-scenario-definition.ts';

export const ALM_LANE_RESULT_DIRECTORY_NAME = 'alm-lane-result';

export const ALM_LANE_BACKENDS = ['memory', 'postgres'] as const;

export type AlmLaneBackend = typeof ALM_LANE_BACKENDS[number];

export const ALM_LANE_SCENARIO_OUTCOMES = ['passed', 'failed', 'not-run'] as const;

export type AlmLaneScenarioOutcome = typeof ALM_LANE_SCENARIO_OUTCOMES[number];

/** The outcome of a scenario that ran to an end. */
export type AlmLaneSettledScenarioOutcome = Exclude<AlmLaneScenarioOutcome, 'not-run'>;

export const ALM_LANE_FAMILY_OUTCOMES = ['passed', 'failed', 'not-finished'] as const;

export type AlmLaneFamilyOutcome = typeof ALM_LANE_FAMILY_OUTCOMES[number];

export interface AlmLaneRunIdentity {
    readonly carrier: AlmConformanceCarrier;
    readonly scope: AlmConformanceTag;
    readonly backend: AlmLaneBackend;
}

export interface AlmLaneScenarioResult {
    readonly scenarioKey: string;
    readonly outcome: AlmLaneScenarioOutcome;
}

export interface AlmLaneFamilyResult extends AlmLaneRunIdentity {
    readonly family: AlmConformanceLaneFamily;
    readonly familyOutcome: AlmLaneFamilyOutcome;
    readonly scenarios: readonly AlmLaneScenarioResult[];
}

export interface AlmLanePlannedFamily {
    readonly family: AlmConformanceLaneFamily;
    readonly scenarioKeys: readonly string[];
}

export interface AlmLanePlanRecord extends AlmLaneRunIdentity {
    readonly families: readonly AlmLanePlannedFamily[];
}

export interface ToAlmLaneFamilyResultInput {
    readonly identity: AlmLaneRunIdentity;
    readonly family: AlmConformanceLaneFamily;
    /** The family's planned scenarios, in the order they were planned to run. */
    readonly scenarioKeys: readonly string[];
    /** The outcome of each scenario that ran to an end; a planned scenario absent here did not run. */
    readonly settled: ReadonlyMap<string, AlmLaneSettledScenarioOutcome>;
    readonly familyOutcome: AlmLaneFamilyOutcome;
}

export interface ResolveAlmLaneScenarioOutcomeInput {
    readonly threw: boolean;
    /** The family test's soft-error count before the scenario ran. */
    readonly errorsBefore: number;
    /** The family test's soft-error count after the scenario ran. */
    readonly errorsAfter: number;
}

/** A family test's result: every planned scenario's outcome, in plan order, and nothing the plan does not name. */
export function toAlmLaneFamilyResult(input: ToAlmLaneFamilyResultInput): AlmLaneFamilyResult {
    return {
        ...input.identity,
        family: input.family,
        familyOutcome: input.familyOutcome,
        scenarios: input.scenarioKeys.map((scenarioKey) => ({
            scenarioKey,
            outcome: input.settled.get(scenarioKey) ?? 'not-run'
        }))
    };
}

/** A scenario fails when it threw or when it added a soft error to the family test. */
export function resolveAlmLaneScenarioOutcome(
    input: ResolveAlmLaneScenarioOutcomeInput
): AlmLaneSettledScenarioOutcome {
    if (input.threw || input.errorsAfter > input.errorsBefore) {
        return 'failed';
    }

    return 'passed';
}

export function toAlmLaneFamilyResultFileName(
    result: Pick<AlmLaneFamilyResult, 'carrier' | 'scope' | 'family'>
): string {
    return `${result.carrier}-${result.scope}-${result.family}.json`;
}

export function toAlmLanePlanFileName(identity: Pick<AlmLaneRunIdentity, 'carrier' | 'scope'>): string {
    return `${identity.carrier}-${identity.scope}-plan.json`;
}
