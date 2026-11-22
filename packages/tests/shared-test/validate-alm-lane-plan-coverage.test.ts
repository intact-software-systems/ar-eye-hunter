import { describe, expect, it } from 'vitest';

import { validateAlmLanePlanCoverage } from '@shared-test/rallar-bb-test/conformance/alm/lane/validate-alm-lane-plan-coverage.ts';

const empty = [{ family: 'two-agent', scenarioKeys: [] }, { family: 'addressed', scenarioKeys: [] }] as const;

describe('validateAlmLanePlanCoverage', () => {
    it('refuses a run that is not narrowed and plans no scenario', () => {
        expect(validateAlmLanePlanCoverage({ carrier: 'rtc', scope: 'smoke', families: empty, only: [], skip: [] }))
            .toEqual(['no smoke ALM scenario runs over rtc']);
    });

    it.each([
        { only: ['ws/two-agent/basic'], skip: [] },
        { only: [], skip: ['basic'] }
    ])('accepts a narrowed run that plans no scenario: %j', ({ only, skip }) => {
        expect(validateAlmLanePlanCoverage({ carrier: 'rtc', scope: 'smoke', families: empty, only, skip })).toEqual([]);
    });

    it('accepts a run in which one family plans a scenario', () => {
        const families = [...empty, { family: 'four-role', scenarioKeys: ['a'] }] as const;

        expect(validateAlmLanePlanCoverage({ carrier: 'rtc', scope: 'full', families, only: [], skip: [] })).toEqual([]);
    });
});
