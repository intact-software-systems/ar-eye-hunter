import { describe, expect, it } from 'vitest';

import {
    resolveAlmLaneScenarioOutcome,
    toAlmLaneFamilyResult,
    toAlmLaneFamilyResultFileName,
    toAlmLanePlanFileName,
    type AlmLaneRunIdentity
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';

const identity: AlmLaneRunIdentity = { carrier: 'ws', scope: 'smoke', backend: 'memory' };

describe('toAlmLaneFamilyResult', () => {
    it('records every planned scenario in plan order, marking an unsettled one not-run', () => {
        const result = toAlmLaneFamilyResult({
            identity,
            family: 'two-agent',
            scenarioKeys: ['a', 'b', 'c'],
            settled: new Map([['a', 'passed'], ['b', 'failed']]),
            familyOutcome: 'failed'
        });

        expect(result).toEqual({
            carrier: 'ws',
            scope: 'smoke',
            backend: 'memory',
            family: 'two-agent',
            familyOutcome: 'failed',
            scenarios: [
                { scenarioKey: 'a', outcome: 'passed' },
                { scenarioKey: 'b', outcome: 'failed' },
                { scenarioKey: 'c', outcome: 'not-run' }
            ]
        });
    });

    it('leaves out a settled scenario the plan does not name', () => {
        const result = toAlmLaneFamilyResult({
            identity,
            family: 'two-agent',
            scenarioKeys: ['a'],
            settled: new Map([['a', 'passed'], ['unplanned', 'failed']]),
            familyOutcome: 'passed'
        });

        expect(result.scenarios).toEqual([{ scenarioKey: 'a', outcome: 'passed' }]);
    });
});

describe('resolveAlmLaneScenarioOutcome', () => {
    it('fails a scenario that threw', () => {
        expect(resolveAlmLaneScenarioOutcome({ threw: true, errorsBefore: 0, errorsAfter: 0 })).toBe('failed');
    });

    it('fails a scenario that added a soft error', () => {
        expect(resolveAlmLaneScenarioOutcome({ threw: false, errorsBefore: 2, errorsAfter: 3 })).toBe('failed');
    });

    it('passes a scenario that neither threw nor added an error', () => {
        expect(resolveAlmLaneScenarioOutcome({ threw: false, errorsBefore: 2, errorsAfter: 2 })).toBe('passed');
    });
});

describe('ALM lane result file names', () => {
    it('names a family result by carrier, scope and family', () => {
        expect(toAlmLaneFamilyResultFileName({ carrier: 'ws', scope: 'smoke', family: 'two-agent' })).toBe(
            'ws-smoke-two-agent.json'
        );
    });

    it('names the plan record by carrier and scope', () => {
        expect(toAlmLanePlanFileName({ carrier: 'rtc', scope: 'full' })).toBe('rtc-full-plan.json');
    });
});
