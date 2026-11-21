import type { TestInfoError } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import type { AlmLaneFamilyResult } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import {
    startLaneFamilyRecorder,
    type LaneFamilyRecorder
} from '../../../tests/playwright/rallar-black-box/start-lane-family-recorder.ts';

describe('the lane family recorder', () => {
    interface Family {
        readonly errors: TestInfoError[];
        readonly written: AlmLaneFamilyResult[];
        readonly recorder: LaneFamilyRecorder;
    }

    async function startFamily(): Promise<Family> {
        const errors: TestInfoError[] = [];
        const written: AlmLaneFamilyResult[] = [];
        const recorder = await startLaneFamilyRecorder({
            testInfo: { errors },
            identity: { carrier: 'ws', scope: 'smoke', backend: 'memory' },
            family: 'two-agent',
            scenarioKeys: ['a', 'b', 'c'],
            writeResult: async (result) => {
                written.push(result);
            }
        });
        return { errors, written, recorder };
    }

    function toOutcomes(result: AlmLaneFamilyResult | undefined): Readonly<Record<string, string>> {
        return Object.fromEntries((result?.scenarios ?? []).map(({ scenarioKey, outcome }) => [scenarioKey, outcome]));
    }

    it('writes every planned scenario as not run when it starts', async () => {
        const family = await startFamily();

        expect(family.written).toEqual([{
            carrier: 'ws',
            scope: 'smoke',
            backend: 'memory',
            family: 'two-agent',
            familyOutcome: 'not-finished',
            scenarios: [
                { scenarioKey: 'a', outcome: 'not-run' },
                { scenarioKey: 'b', outcome: 'not-run' },
                { scenarioKey: 'c', outcome: 'not-run' }
            ]
        }]);
    });

    it('records a passing scenario and one that adds a soft error, and leaves the rest not run', async () => {
        const family = await startFamily();

        await family.recorder.runScenario('a', async () => {});
        await family.recorder.runScenario('b', async () => {
            family.errors.push({ message: 'b failed softly' });
        });

        const last = family.written.at(-1);
        expect(toOutcomes(last)).toEqual({ a: 'passed', b: 'failed', c: 'not-run' });
        expect(last?.familyOutcome).toBe('not-finished');
    });

    it('records a scenario that throws as failed and rethrows its error', async () => {
        const family = await startFamily();
        const failure = new Error('a threw');

        await expect(family.recorder.runScenario('a', async () => await Promise.reject(failure))).rejects.toBe(failure);

        expect(toOutcomes(family.written.at(-1))).toEqual({ a: 'failed', b: 'not-run', c: 'not-run' });
    });

    it('writes the family outcome when the family finishes and leaves the scenarios as they were', async () => {
        const family = await startFamily();
        await family.recorder.runScenario('a', async () => {});

        await family.recorder.finish('passed');

        const last = family.written.at(-1);
        expect(last?.familyOutcome).toBe('passed');
        expect(toOutcomes(last)).toEqual({ a: 'passed', b: 'not-run', c: 'not-run' });
    });

    it('does not fail a scenario for an error the family test held before it started', async () => {
        const family = await startFamily();
        family.errors.push({ message: 'an earlier failure' });

        await family.recorder.runScenario('a', async () => {});

        expect(toOutcomes(family.written.at(-1))).toEqual({ a: 'passed', b: 'not-run', c: 'not-run' });
    });
});
