import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    toAlmLaneFamilyResult,
    type AlmLaneFamilyOutcome,
    type AlmLaneFamilyResult,
    type AlmLanePlanRecord,
    type AlmLaneSettledScenarioOutcome
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import type { AlmLaneObservedRun } from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-run-reading.ts';

/** The plan every fixture run states: `two-agent` plans a and b, `three-agent` plans c, `four-role` plans nothing. */
export const ALM_LANE_FIXTURE_PLANNED_KEYS: Readonly<Partial<Record<AlmConformanceLaneFamily, readonly string[]>>> = {
    'two-agent': ['a', 'b'],
    'three-agent': ['c'],
    'four-role': []
};

export function toFixturePlan(carrier: AlmConformanceCarrier): AlmLanePlanRecord {
    return {
        carrier,
        scope: 'full',
        backend: 'postgres',
        families: Object.entries(ALM_LANE_FIXTURE_PLANNED_KEYS).map(([family, scenarioKeys]) => ({
            family: family as AlmConformanceLaneFamily,
            scenarioKeys: scenarioKeys ?? []
        }))
    };
}

export function toFixtureResult(
    carrier: AlmConformanceCarrier,
    family: AlmConformanceLaneFamily,
    settled: ReadonlyMap<string, AlmLaneSettledScenarioOutcome>,
    familyOutcome: AlmLaneFamilyOutcome = 'passed'
): AlmLaneFamilyResult {
    return toAlmLaneFamilyResult({
        identity: { carrier, scope: 'full', backend: 'postgres' },
        family,
        scenarioKeys: ALM_LANE_FIXTURE_PLANNED_KEYS[family] ?? [],
        settled,
        familyOutcome
    });
}

/** A first-attempt `push` run whose job succeeded and whose every planned scenario passed. */
export function toFixtureGreenRun(runId: number, carrier: AlmConformanceCarrier = 'ws'): AlmLaneObservedRun {
    return {
        runId,
        commitSha: `sha-${runId}`,
        event: 'push',
        attempt: 1,
        carrier,
        jobConclusion: 'success',
        plan: toFixturePlan(carrier),
        familyResults: [
            toFixtureResult(carrier, 'two-agent', new Map([['a', 'passed'], ['b', 'passed']])),
            toFixtureResult(carrier, 'three-agent', new Map([['c', 'passed']]))
        ]
    };
}

/** A green `ws` run whose job failed and whose `two-agent` result is replaced. */
export function toFixtureRunWithTwoAgentResult(runId: number, twoAgent: AlmLaneFamilyResult): AlmLaneObservedRun {
    const green = toFixtureGreenRun(runId);
    return {
        ...green,
        jobConclusion: 'failure',
        familyResults: [twoAgent, ...green.familyResults.filter((result) => result.family !== 'two-agent')]
    };
}
