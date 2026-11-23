import { describe, expect, it } from 'vitest';

import {
    toAlmLaneFamilyResult,
    type AlmLanePlanRecord,
    type AlmLaneRunIdentity
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import {
    decodeAlmLaneFamilyResult,
    decodeAlmLanePlanRecord
} from '@shared-test/rallar-bb-test/conformance/alm/lane-result/decode-alm-lane-result.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { Either } from '@shared/resilience/Either.ts';

const identity: AlmLaneRunIdentity = { carrier: 'rtc-with-ws-fallback', scope: 'full', backend: 'postgres' };

const familyResult = toAlmLaneFamilyResult({
    identity,
    family: 'three-agent',
    scenarioKeys: ['a', 'b', 'c'],
    settled: new Map([['a', 'passed'], ['b', 'failed']]),
    familyOutcome: 'not-finished'
});

const planRecord: AlmLanePlanRecord = {
    ...identity,
    families: [
        { family: 'two-agent', scenarioKeys: ['a', 'b'] },
        { family: 'four-role', scenarioKeys: [] }
    ]
};

/** A value as it comes back from a written file. */
function toWritten(value: object): ApiJsonValue {
    return JSON.parse(JSON.stringify(value));
}

function toIssues<T>(decoded: Either<readonly string[], T>): readonly string[] {
    return decoded.fold((issues) => issues, () => []);
}

describe('decodeAlmLaneFamilyResult', () => {
    it('round-trips a written family result', () => {
        const decoded = decodeAlmLaneFamilyResult(toWritten(familyResult));

        expect(decoded.right).toEqual(familyResult);
    });

    it('ignores and drops an unknown extra field', () => {
        const decoded = decodeAlmLaneFamilyResult(toWritten({ ...familyResult, writtenBy: 'a later lane' }));

        expect(decoded.right).toEqual(familyResult);
    });

    it.each([
        ['carrier', 'tcp', 'carrier is "tcp"'],
        ['scope', 'nightly', 'scope is "nightly"'],
        ['backend', 'sqlite', 'backend is "sqlite"'],
        ['family', 'five-role', 'family is "five-role"'],
        ['familyOutcome', 'skipped', 'familyOutcome is "skipped"']
    ])('names an unknown %s with the value received', (field, received, issue) => {
        const issues = toIssues(decodeAlmLaneFamilyResult(toWritten({ ...familyResult, [field]: received })));

        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain(issue);
    });

    it('names an unknown scenario outcome by its path', () => {
        const scenarios = [...familyResult.scenarios.slice(0, 2), { scenarioKey: 'c', outcome: 'flaky' }];

        const issues = toIssues(decodeAlmLaneFamilyResult(toWritten({ ...familyResult, scenarios })));

        expect(issues).toEqual([expect.stringContaining('scenarios[2].outcome is "flaky"')]);
    });

    it('names a missing field and a wrongly typed field, returning every issue', () => {
        const { carrier: _carrier, ...withoutCarrier } = familyResult;
        const scenarios = [{ outcome: 'passed' }, { scenarioKey: 7, outcome: 'passed' }];

        const issues = toIssues(decodeAlmLaneFamilyResult(toWritten({ ...withoutCarrier, scenarios })));

        expect(issues).toEqual([
            expect.stringContaining('carrier is missing'),
            expect.stringContaining('scenarios[0].scenarioKey is missing'),
            expect.stringContaining('scenarios[1].scenarioKey is 7')
        ]);
    });

    it('names scenarios that are not an array', () => {
        const issues = toIssues(decodeAlmLaneFamilyResult(toWritten({ ...familyResult, scenarios: { a: 'passed' } })));

        expect(issues).toEqual([expect.stringContaining('scenarios is an object')]);
    });

    it('names a scenario key that appears twice', () => {
        const scenarios = [...familyResult.scenarios, { scenarioKey: 'a', outcome: 'failed' }];

        const issues = toIssues(decodeAlmLaneFamilyResult(toWritten({ ...familyResult, scenarios })));

        expect(issues).toEqual([expect.stringContaining('scenarios names scenarioKey "a" more than once')]);
    });

    it.each([null, 'result', 3, [familyResult]])('refuses a value that is not an object: %j', (value) => {
        const issues = toIssues(decodeAlmLaneFamilyResult(value));

        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain('must be an object');
    });
});

describe('decodeAlmLanePlanRecord', () => {
    it('round-trips a written plan record, with a family that plans no scenario', () => {
        const decoded = decodeAlmLanePlanRecord(toWritten(planRecord));

        expect(decoded.right).toEqual(planRecord);
    });

    it('ignores and drops an unknown extra field', () => {
        const families = planRecord.families.map((planned) => ({ ...planned, note: 'extra' }));

        const decoded = decodeAlmLanePlanRecord(toWritten({ ...planRecord, families, seed: 4 }));

        expect(decoded.right).toEqual(planRecord);
    });

    it.each([
        ['carrier', 'tcp', 'carrier is "tcp"'],
        ['scope', 'nightly', 'scope is "nightly"'],
        ['backend', 'sqlite', 'backend is "sqlite"']
    ])('names an unknown %s with the value received', (field, received, issue) => {
        const issues = toIssues(decodeAlmLanePlanRecord(toWritten({ ...planRecord, [field]: received })));

        expect(issues).toEqual([expect.stringContaining(issue)]);
    });

    it('names an unknown family and a wrongly typed scenario key by their paths', () => {
        const families = [{ family: 'five-role', scenarioKeys: [] }, { family: 'two-agent', scenarioKeys: ['a', 2] }];

        const issues = toIssues(decodeAlmLanePlanRecord(toWritten({ ...planRecord, families })));

        expect(issues).toEqual([
            expect.stringContaining('families[0].family is "five-role"'),
            expect.stringContaining('families[1].scenarioKeys[1] is 2')
        ]);
    });

    it('names missing fields', () => {
        const { families: _families, ...withoutFamilies } = planRecord;

        const issues = toIssues(decodeAlmLanePlanRecord(toWritten({ ...withoutFamilies, backend: undefined })));

        expect(issues).toEqual([
            expect.stringContaining('backend is missing'),
            expect.stringContaining('families is missing')
        ]);
    });

    it('names a family planned twice and a scenario key planned twice in one family', () => {
        const families = [
            { family: 'two-agent', scenarioKeys: ['a', 'a'] },
            { family: 'two-agent', scenarioKeys: [] }
        ];

        const issues = toIssues(decodeAlmLanePlanRecord(toWritten({ ...planRecord, families })));

        expect(issues).toEqual([
            expect.stringContaining('families[0].scenarioKeys names "a" more than once'),
            expect.stringContaining('families names family "two-agent" more than once')
        ]);
    });

    it.each([null, 'plan', [planRecord]])('refuses a value that is not an object: %j', (value) => {
        const issues = toIssues(decodeAlmLanePlanRecord(value));

        expect(issues).toEqual([expect.stringContaining('must be an object')]);
    });
});
