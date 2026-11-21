import { describe, expect, it } from 'vitest';

import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import {
    toAlmLaneFamilyResult,
    type AlmLaneFamilyOutcome,
    type AlmLaneFamilyResult,
    type AlmLanePlanRecord,
    type AlmLaneSettledScenarioOutcome
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import {
    computeAlmLaneLedger,
    type AlmLaneFlakeCause,
    type AlmLaneObservedRun
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-ledger.ts';

const PLANNED_KEYS: Readonly<Partial<Record<AlmConformanceLaneFamily, readonly string[]>>> = {
    'two-agent': ['a', 'b'],
    'three-agent': ['c'],
    'four-role': []
};

function toPlan(carrier: AlmConformanceCarrier): AlmLanePlanRecord {
    return {
        carrier,
        scope: 'full',
        backend: 'postgres',
        families: Object.entries(PLANNED_KEYS).map(([family, scenarioKeys]) => ({
            family: family as AlmConformanceLaneFamily,
            scenarioKeys: scenarioKeys ?? []
        }))
    };
}

function toResult(
    carrier: AlmConformanceCarrier,
    family: AlmConformanceLaneFamily,
    settled: ReadonlyMap<string, AlmLaneSettledScenarioOutcome>,
    familyOutcome: AlmLaneFamilyOutcome = 'passed'
): AlmLaneFamilyResult {
    return toAlmLaneFamilyResult({
        identity: { carrier, scope: 'full', backend: 'postgres' },
        family,
        scenarioKeys: PLANNED_KEYS[family] ?? [],
        settled,
        familyOutcome
    });
}

/** A first-attempt `push` run whose job succeeded and whose every planned scenario passed. */
function toGreenRun(runId: number, carrier: AlmConformanceCarrier = 'ws'): AlmLaneObservedRun {
    return {
        runId,
        commitSha: `sha-${runId}`,
        event: 'push',
        attempt: 1,
        carrier,
        jobConclusion: 'success',
        plan: toPlan(carrier),
        familyResults: [
            toResult(carrier, 'two-agent', new Map([['a', 'passed'], ['b', 'passed']])),
            toResult(carrier, 'three-agent', new Map([['c', 'passed']]))
        ]
    };
}

/** A green run whose `two-agent` result is replaced. */
function toRunWithTwoAgentResult(runId: number, twoAgent: AlmLaneFamilyResult): AlmLaneObservedRun {
    const green = toGreenRun(runId);
    return {
        ...green,
        jobConclusion: 'failure',
        familyResults: [twoAgent, ...green.familyResults.filter((result) => result.family !== 'two-agent')]
    };
}

function toLedger(runs: readonly AlmLaneObservedRun[], causes: readonly AlmLaneFlakeCause[] = []) {
    return computeAlmLaneLedger({ runs, causes });
}

function toCarrierStreak(runs: readonly AlmLaneObservedRun[], carrier: AlmConformanceCarrier = 'ws') {
    return toLedger(runs).carriers.find((streak) => streak.carrier === carrier);
}

describe('computeAlmLaneLedger', () => {
    it('counts the green push runs before the newest red one and names that red run', () => {
        const red = toRunWithTwoAgentResult(4, toResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'passed']])));
        const ledger = toLedger([toGreenRun(1), toGreenRun(2), toGreenRun(3), red, toGreenRun(5)]);

        expect(ledger.carriers.find((streak) => streak.carrier === 'ws')).toEqual({
            carrier: 'ws',
            streak: 3,
            lastRed: { runId: 4, commitSha: 'sha-4', failed: ['ws/two-agent/a'], notRun: [] },
            uncaused: ['ws/two-agent/a']
        });
        expect(ledger.scenarios).toEqual([
            { scenario: 'ws/two-agent/a', failedRunIds: [4], notRunRunIds: [], hasCause: false }
        ]);
        expect(ledger.unattributedRedRunIds).toEqual([]);
    });

    it('reads every carrier, with no counted run as a streak of zero and no red run', () => {
        const ledger = toLedger([toGreenRun(1)]);

        expect(ledger.carriers).toEqual([
            { carrier: 'ws', streak: 1, lastRed: null, uncaused: [] },
            { carrier: 'rtc', streak: 0, lastRed: null, uncaused: [] },
            { carrier: 'rtc-with-ws-fallback', streak: 0, lastRed: null, uncaused: [] }
        ]);
    });

    it('keeps a streak per carrier', () => {
        const rtcRed: AlmLaneObservedRun = { ...toGreenRun(2, 'rtc'), jobConclusion: 'failure', plan: null };

        const ledger = toLedger([toGreenRun(1, 'ws'), rtcRed, toGreenRun(3, 'rtc'), toGreenRun(4, 'ws')]);

        expect(ledger.carriers.map(({ carrier, streak }) => ({ carrier, streak }))).toEqual([
            { carrier: 'ws', streak: 2 },
            { carrier: 'rtc', streak: 0 },
            { carrier: 'rtc-with-ws-fallback', streak: 0 }
        ]);
    });

    it('does not count a rerun as green even when every scenario passed', () => {
        const rerun: AlmLaneObservedRun = { ...toGreenRun(1), attempt: 2 };

        const ledger = toLedger([rerun, toGreenRun(2)]);

        expect(ledger.carriers[0]).toEqual({
            carrier: 'ws',
            streak: 0,
            lastRed: { runId: 1, commitSha: 'sha-1', failed: [], notRun: [] },
            uncaused: []
        });
        expect(ledger.unattributedRedRunIds).toEqual([1]);
    });

    it('reads a planned family with no result as red, with its planned scenarios not run', () => {
        const run: AlmLaneObservedRun = {
            ...toGreenRun(1),
            familyResults: toGreenRun(1).familyResults.filter((result) => result.family !== 'three-agent')
        };

        const ledger = toLedger([run]);

        expect(ledger.carriers[0]?.lastRed).toEqual({
            runId: 1,
            commitSha: 'sha-1',
            failed: [],
            notRun: ['ws/three-agent/c']
        });
        expect(ledger.scenarios).toEqual([
            { scenario: 'ws/three-agent/c', failedRunIds: [], notRunRunIds: [1], hasCause: false }
        ]);
    });

    it('needs no result for a planned family with no scenario keys', () => {
        expect(toCarrierStreak([toGreenRun(1)])?.streak).toBe(1);
    });

    it('reads a scenario that did not run as red', () => {
        const run = toRunWithTwoAgentResult(1, toResult('ws', 'two-agent', new Map([['a', 'passed']]), 'not-finished'));

        expect(toCarrierStreak([{ ...run, jobConclusion: 'success' }])?.lastRed?.notRun).toEqual(['ws/two-agent/b']);
    });

    it.each(['not-finished', 'failed'] as const)(
        'keys a %s family whose scenarios all passed by its carrier and family',
        (familyOutcome) => {
            const allPassed = new Map([['a', 'passed'], ['b', 'passed']] as const);
            const run = toRunWithTwoAgentResult(1, toResult('ws', 'two-agent', allPassed, familyOutcome));

            const ledger = toLedger([{ ...run, jobConclusion: 'success' }]);

            expect(ledger.carriers[0]?.lastRed?.failed).toEqual(['ws/two-agent']);
            expect(ledger.scenarios.map((failures) => failures.scenario)).toEqual(['ws/two-agent']);
        }
    );

    it('compares a plan and its results by scenario key, not by position', () => {
        const green = toGreenRun(1);
        const reversed = green.familyResults.map((result) => ({ ...result, scenarios: [...result.scenarios].reverse() }));

        expect(toCarrierStreak([{ ...green, familyResults: reversed }])?.streak).toBe(1);
    });

    it('reads a result for a family the plan does not name as red, keyed by its carrier and family', () => {
        const green = toGreenRun(1);
        const unplanned = toAlmLaneFamilyResult({
            identity: { carrier: 'ws', scope: 'full', backend: 'postgres' },
            family: 'addressed',
            scenarioKeys: ['z'],
            settled: new Map([['z', 'passed']]),
            familyOutcome: 'passed'
        });

        const ledger = toLedger([{ ...green, familyResults: [...green.familyResults, unplanned] }]);

        expect(ledger.carriers[0]?.lastRed?.failed).toEqual(['ws/addressed']);
    });

    it('reads a result naming a scenario the plan does not as red, keyed by its carrier and family', () => {
        const passed = toResult('ws', 'two-agent', new Map([['a', 'passed'], ['b', 'passed']]));
        const extra = { ...passed, scenarios: [...passed.scenarios, { scenarioKey: 'x', outcome: 'passed' as const }] };

        const ledger = toLedger([{ ...toRunWithTwoAgentResult(1, extra), jobConclusion: 'success' }]);

        expect(ledger.carriers[0]?.lastRed?.failed).toEqual(['ws/two-agent']);
    });

    it.each(['in-progress', 'skipped'] as const)('leaves out a %s job without breaking the streak', (jobConclusion) => {
        const ledger = toLedger([{ ...toGreenRun(1), jobConclusion, plan: null }, toGreenRun(2)]);

        expect(ledger.carriers[0]).toEqual({ carrier: 'ws', streak: 1, lastRed: null, uncaused: [] });
        expect(ledger.unattributedRedRunIds).toEqual([]);
        expect(ledger.sideRuns).toEqual([]);
        expect(ledger.leftOutRuns).toEqual([{ runId: 1, event: 'push', carrier: 'ws', jobConclusion }]);
    });

    it('reads a cancelled push job as red, and as unattributed when it has no plan', () => {
        const ledger = toLedger([{ ...toGreenRun(1), jobConclusion: 'cancelled', plan: null }, toGreenRun(2)]);

        expect(ledger.carriers[0]?.streak).toBe(0);
        expect(ledger.unattributedRedRunIds).toEqual([1]);
    });

    it('attributes a cancelled push job that has a plan by its missing results', () => {
        const cancelled: AlmLaneObservedRun = { ...toGreenRun(1), jobConclusion: 'cancelled', familyResults: [] };

        expect(toCarrierStreak([cancelled])?.lastRed?.notRun).toEqual(['ws/two-agent/a', 'ws/two-agent/b', 'ws/three-agent/c']);
    });

    it.each(['pull_request', 'workflow_dispatch'] as const)('leaves out a cancelled %s job', (event) => {
        const ledger = toLedger([{ ...toGreenRun(1), event, jobConclusion: 'cancelled', plan: null }]);

        expect(ledger.sideRuns).toEqual([]);
        expect(ledger.unattributedRedRunIds).toEqual([]);
        expect(ledger.leftOutRuns).toEqual([{ runId: 1, event, carrier: 'ws', jobConclusion: 'cancelled' }]);
    });

    it.each(['failure', 'success'] as const)(
        'reads a %s job with no plan as red with nothing to attribute, naming each run once',
        (jobConclusion) => {
            const ws: AlmLaneObservedRun = { ...toGreenRun(1, 'ws'), jobConclusion, plan: null, familyResults: [] };
            const rtc: AlmLaneObservedRun = { ...toGreenRun(1, 'rtc'), jobConclusion, plan: null, familyResults: [] };

            const ledger = toLedger([ws, rtc]);

            expect(ledger.carriers[0]?.lastRed).toEqual({ runId: 1, commitSha: 'sha-1', failed: [], notRun: [] });
            expect(ledger.unattributedRedRunIds).toEqual([1]);
            expect(ledger.scenarios).toEqual([]);
        }
    );

    it('reads a failed job as red even when every recorded scenario passed', () => {
        const ledger = toLedger([{ ...toGreenRun(1), jobConclusion: 'failure' }]);

        expect(ledger.carriers[0]?.streak).toBe(0);
        expect(ledger.unattributedRedRunIds).toEqual([1]);
    });

    it('shows pull-request and dispatched runs only beside the streak', () => {
        const failed = toRunWithTwoAgentResult(2, toResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'passed']])));
        const pullRequest: AlmLaneObservedRun = { ...failed, event: 'pull_request' };
        const dispatched: AlmLaneObservedRun = { ...toGreenRun(3, 'rtc'), event: 'workflow_dispatch' };
        const unplanned: AlmLaneObservedRun = { ...toGreenRun(4), event: 'pull_request', jobConclusion: 'failure', plan: null };

        const ledger = toLedger([pullRequest, dispatched, unplanned, toGreenRun(1)]);

        expect(ledger.sideRuns).toEqual([
            { runId: 2, event: 'pull_request', carrier: 'ws', green: false },
            { runId: 3, event: 'workflow_dispatch', carrier: 'rtc', green: true },
            { runId: 4, event: 'pull_request', carrier: 'ws', green: false }
        ]);
        expect(ledger.carriers.map((streak) => streak.streak)).toEqual([1, 0, 0]);
        expect(ledger.scenarios).toEqual([]);
        expect(ledger.unattributedRedRunIds).toEqual([]);
    });

    it('marks a failed scenario with a recorded cause, and one without', () => {
        const failed = toResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'failed']]));
        const causes: readonly AlmLaneFlakeCause[] = [
            { scenario: 'ws/two-agent/a', cause: 'A settle window raced the relay.', fixedByPullRequest: null }
        ];

        const ledger = toLedger([toRunWithTwoAgentResult(1, failed)], causes);

        expect(ledger.scenarios.map(({ scenario, hasCause }) => ({ scenario, hasCause }))).toEqual([
            { scenario: 'ws/two-agent/a', hasCause: true },
            { scenario: 'ws/two-agent/b', hasCause: false }
        ]);
    });

    it('collects one scenario across the push runs that failed it', () => {
        const failed = toResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'passed']]));

        const ledger = toLedger([
            toRunWithTwoAgentResult(3, failed),
            toGreenRun(2),
            toRunWithTwoAgentResult(1, failed)
        ]);

        expect(ledger.scenarios).toEqual([
            { scenario: 'ws/two-agent/a', failedRunIds: [3, 1], notRunRunIds: [], hasCause: false }
        ]);
    });

    it('keys a failed scenario and a following unrun one, with no family key, when the family failed', () => {
        const run = toRunWithTwoAgentResult(1, toResult('ws', 'two-agent', new Map([['a', 'failed']]), 'failed'));

        expect(toCarrierStreak([run])?.lastRed).toEqual({
            runId: 1,
            commitSha: 'sha-1',
            failed: ['ws/two-agent/a'],
            notRun: ['ws/two-agent/b']
        });
    });

    it('lists per carrier the failed and unrun keys of counted runs that have no recorded cause', () => {
        const failed = toResult('ws', 'two-agent', new Map([['a', 'failed']]), 'failed');
        const causes: readonly AlmLaneFlakeCause[] = [
            { scenario: 'ws/two-agent/a', cause: 'A settle window raced the relay.', fixedByPullRequest: null }
        ];
        const pullRequest: AlmLaneObservedRun = { ...toRunWithTwoAgentResult(2, failed), event: 'pull_request' };

        const ledger = toLedger([toRunWithTwoAgentResult(1, failed), pullRequest], causes);

        expect(ledger.carriers.map(({ carrier, uncaused }) => ({ carrier, uncaused }))).toEqual([
            { carrier: 'ws', uncaused: ['ws/two-agent/b'] },
            { carrier: 'rtc', uncaused: [] },
            { carrier: 'rtc-with-ws-fallback', uncaused: [] }
        ]);
    });

    it('lists a red run that names only unrun scenarios as failures without a cause', () => {
        const run: AlmLaneObservedRun = { ...toGreenRun(1), jobConclusion: 'cancelled', familyResults: [] };

        expect(toCarrierStreak([run])?.uncaused).toEqual(['ws/three-agent/c', 'ws/two-agent/a', 'ws/two-agent/b']);
    });

    it('changes nothing for a cause whose scenario never failed', () => {
        const red = toRunWithTwoAgentResult(1, toResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'passed']])));
        const unrelated: AlmLaneFlakeCause = { scenario: 'rtc/two-agent/a', cause: 'Never seen.', fixedByPullRequest: 1 };

        expect(toLedger([red, toGreenRun(2)], [unrelated])).toEqual(toLedger([red, toGreenRun(2)]));
    });

    it('reads a run whose plan names another carrier as red with nothing to attribute', () => {
        const run: AlmLaneObservedRun = { ...toGreenRun(1), plan: toPlan('rtc') };

        const ledger = toLedger([run]);

        expect(ledger.carriers[0]?.lastRed).toEqual({ runId: 1, commitSha: 'sha-1', failed: [], notRun: [] });
        expect(ledger.unattributedRedRunIds).toEqual([1]);
    });

    it('reads a result that names another carrier as red, keyed by the run carrier and the family', () => {
        const green = toGreenRun(1);
        const foreign = toResult('rtc', 'three-agent', new Map([['c', 'passed']]));

        const ledger = toLedger([{ ...green, familyResults: [...green.familyResults, foreign] }]);

        expect(ledger.carriers[0]?.lastRed?.failed).toEqual(['ws/three-agent']);
    });

    it('reads two results for one family as red, keyed by its carrier and family', () => {
        const green = toGreenRun(1);
        const twice = toResult('ws', 'three-agent', new Map([['c', 'passed']]));

        const ledger = toLedger([{ ...green, familyResults: [...green.familyResults, twice] }]);

        expect(ledger.carriers[0]?.lastRed?.failed).toEqual(['ws/three-agent']);
    });
});
