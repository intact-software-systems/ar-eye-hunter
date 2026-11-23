import { describe, expect, it } from 'vitest';

import { toAlmLaneFamilyResult } from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import {
    computeAlmLaneRunReading,
    type AlmLaneObservedRun
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/compute-alm-lane-run-reading.ts';

import {
    toFixtureGreenRun,
    toFixturePlan,
    toFixtureResult,
    toFixtureRunWithTwoAgentResult
} from './alm-lane-ledger-fixture.ts';

const twoAgentFailedA = toFixtureResult('ws', 'two-agent', new Map([['a', 'failed'], ['b', 'passed']]));

describe('computeAlmLaneRunReading', () => {
    it('reads a first-attempt successful run whose every planned scenario passed as green', () => {
        expect(computeAlmLaneRunReading(toFixtureGreenRun(1))).toEqual({
            run: toFixtureGreenRun(1),
            green: true,
            planRead: true,
            failed: [],
            notRun: [],
            candidates: [],
            unattributedReason: null
        });
    });

    it('keys a failed scenario by carrier, family and scenario, and makes it the candidate', () => {
        const reading = computeAlmLaneRunReading(toFixtureRunWithTwoAgentResult(1, twoAgentFailedA));

        expect(reading).toMatchObject({ green: false, failed: ['ws/two-agent/a'], notRun: [], unattributedReason: null });
        expect(reading.candidates).toEqual(['ws/two-agent/a']);
    });

    it('lets a failed scenario answer for the unrun ones after it, with no family key', () => {
        const failedThenUnrun = toFixtureResult('ws', 'two-agent', new Map([['a', 'failed']]), 'failed');

        const reading = computeAlmLaneRunReading(toFixtureRunWithTwoAgentResult(1, failedThenUnrun));

        expect(reading).toMatchObject({ failed: ['ws/two-agent/a'], notRun: ['ws/two-agent/b'] });
        expect(reading.candidates).toEqual(['ws/two-agent/a']);
    });

    it('makes the family key the candidate, once, for a family cut off with no failed scenario', () => {
        const cutOff = toFixtureResult('ws', 'two-agent', new Map(), 'not-finished');

        const reading = computeAlmLaneRunReading(toFixtureRunWithTwoAgentResult(1, cutOff));

        expect(reading.notRun).toEqual(['ws/two-agent/a', 'ws/two-agent/b']);
        expect(reading.candidates).toEqual(['ws/two-agent']);
    });

    it('makes the family key the candidate for a planned family with no result', () => {
        const run: AlmLaneObservedRun = { ...toFixtureGreenRun(1), familyResults: [] };

        const reading = computeAlmLaneRunReading(run);

        expect(reading.notRun).toEqual(['ws/two-agent/a', 'ws/two-agent/b', 'ws/three-agent/c']);
        expect(reading.candidates).toEqual(['ws/two-agent', 'ws/three-agent']);
    });

    it('needs no result for a planned family with no scenario keys', () => {
        expect(computeAlmLaneRunReading(toFixtureGreenRun(1)).green).toBe(true);
    });

    it.each(['not-finished', 'failed'] as const)(
        'keys a %s family whose scenarios all passed by its carrier and family',
        (familyOutcome) => {
            const allPassed = toFixtureResult('ws', 'two-agent', new Map([['a', 'passed'], ['b', 'passed']]), familyOutcome);

            const reading = computeAlmLaneRunReading({ ...toFixtureRunWithTwoAgentResult(1, allPassed), jobConclusion: 'success' });

            expect(reading.failed).toEqual(['ws/two-agent']);
            expect(reading.candidates).toEqual(['ws/two-agent']);
        }
    );

    it('compares a plan and its results by scenario key, not by position', () => {
        const green = toFixtureGreenRun(1);
        const reversed = green.familyResults.map((result) => ({ ...result, scenarios: [...result.scenarios].reverse() }));

        expect(computeAlmLaneRunReading({ ...green, familyResults: reversed }).green).toBe(true);
    });

    it('keys a result for a family the plan does not name by its carrier and family', () => {
        const unplanned = toAlmLaneFamilyResult({
            identity: { carrier: 'ws', scope: 'full', backend: 'postgres' },
            family: 'addressed',
            scenarioKeys: ['z'],
            settled: new Map([['z', 'passed']]),
            familyOutcome: 'passed'
        });
        const green = toFixtureGreenRun(1);

        expect(computeAlmLaneRunReading({ ...green, familyResults: [...green.familyResults, unplanned] }).failed)
            .toEqual(['ws/addressed']);
    });

    it('keys a result naming a scenario the plan does not by its carrier and family', () => {
        const passed = toFixtureResult('ws', 'two-agent', new Map([['a', 'passed'], ['b', 'passed']]));
        const extra = { ...passed, scenarios: [...passed.scenarios, { scenarioKey: 'x', outcome: 'passed' as const }] };

        const reading = computeAlmLaneRunReading({ ...toFixtureRunWithTwoAgentResult(1, extra), jobConclusion: 'success' });

        expect(reading.failed).toEqual(['ws/two-agent']);
    });

    it('keys a result for another carrier by the run carrier and the family', () => {
        const green = toFixtureGreenRun(1);
        const foreign = toFixtureResult('rtc', 'three-agent', new Map([['c', 'passed']]));

        expect(computeAlmLaneRunReading({ ...green, familyResults: [...green.familyResults, foreign] }).failed)
            .toEqual(['ws/three-agent']);
    });

    it('keys a second result for one family by its carrier and family', () => {
        const green = toFixtureGreenRun(1);
        const twice = toFixtureResult('ws', 'three-agent', new Map([['c', 'passed']]));

        expect(computeAlmLaneRunReading({ ...green, familyResults: [...green.familyResults, twice] }).failed)
            .toEqual(['ws/three-agent']);
    });

    describe('a red run with nothing to attribute', () => {
        it('names a rerun, and makes the run key the candidate', () => {
            const reading = computeAlmLaneRunReading({ ...toFixtureGreenRun(7), attempt: 2 });

            expect(reading).toMatchObject({ green: false, failed: [], notRun: [], unattributedReason: 'rerun' });
            expect(reading.candidates).toEqual(['ws/run/7']);
        });

        it('names a failed job whose every recorded scenario passed', () => {
            expect(computeAlmLaneRunReading({ ...toFixtureGreenRun(1), jobConclusion: 'failure' }).unattributedReason)
                .toBe('job-not-success');
        });

        it.each(['failure', 'success'] as const)('names a %s job with no plan', (jobConclusion) => {
            const reading = computeAlmLaneRunReading({ ...toFixtureGreenRun(1), jobConclusion, plan: null, familyResults: [] });

            expect(reading).toMatchObject({ green: false, planRead: false, unattributedReason: 'no-plan' });
        });

        it('names a cancelled job with no plan as cancelled', () => {
            const cancelled: AlmLaneObservedRun = { ...toFixtureGreenRun(1), jobConclusion: 'cancelled', plan: null };

            expect(computeAlmLaneRunReading(cancelled).unattributedReason).toBe('cancelled');
        });

        it('names a carrier of a completed run whose job could not be read', () => {
            const notRead: AlmLaneObservedRun = { ...toFixtureGreenRun(1), jobConclusion: 'not-read', plan: null, familyResults: [] };

            expect(computeAlmLaneRunReading(notRead).unattributedReason).toBe('no-job-read');
        });

        it('names a plan that plans no scenario at all', () => {
            const plan = { ...toFixturePlan('ws'), families: [{ family: 'four-role' as const, scenarioKeys: [] }] };

            const reading = computeAlmLaneRunReading({ ...toFixtureGreenRun(1), plan, familyResults: [] });

            expect(reading).toMatchObject({ green: false, unattributedReason: 'plan-plans-nothing' });
        });

        it('reads a plan for another carrier as no plan', () => {
            const reading = computeAlmLaneRunReading({ ...toFixtureGreenRun(1), plan: toFixturePlan('rtc') });

            expect(reading).toMatchObject({ green: false, planRead: false, unattributedReason: 'no-plan' });
        });
    });

    it('attributes a cancelled job that has a plan by its missing results', () => {
        const cancelled: AlmLaneObservedRun = { ...toFixtureGreenRun(1), jobConclusion: 'cancelled', familyResults: [] };

        const reading = computeAlmLaneRunReading(cancelled);

        expect(reading.notRun).toEqual(['ws/two-agent/a', 'ws/two-agent/b', 'ws/three-agent/c']);
        expect(reading.unattributedReason).toBeNull();
    });
});
