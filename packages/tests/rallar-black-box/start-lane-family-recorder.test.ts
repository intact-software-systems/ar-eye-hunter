import type { TestInfoError } from '@playwright/test';
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AlmLaneFamilyResult } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts';
import {
    startLaneFamilyRecorder,
    writeLaneResultFile,
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

    it('records the family as passed when its body ends cleanly, leaving the scenarios as they were', async () => {
        const family = await startFamily();

        await family.recorder.runFamily(async () => {
            await family.recorder.runScenario('a', async () => {});
        });

        const last = family.written.at(-1);
        expect(last?.familyOutcome).toBe('passed');
        expect(toOutcomes(last)).toEqual({ a: 'passed', b: 'not-run', c: 'not-run' });
    });

    it('records the family as failed when its body throws outside any scenario, and rethrows that error', async () => {
        const family = await startFamily();
        const failure = new Error('the pages did not open');

        await expect(family.recorder.runFamily(async () => await Promise.reject(failure))).rejects.toBe(failure);

        expect(family.written.at(-1)?.familyOutcome).toBe('failed');
    });

    it('records the family as failed when its body ends with a soft error recorded', async () => {
        const family = await startFamily();

        await family.recorder.runFamily(async () => {
            family.errors.push({ message: 'the close failed softly' });
        });

        expect(family.written.at(-1)?.familyOutcome).toBe('failed');
    });

    it('reports a scenario\'s own error when writing its result fails', async () => {
        const failure = new Error('a threw');
        const recorder = await startLaneFamilyRecorder({
            testInfo: { errors: [] },
            identity: { carrier: 'ws', scope: 'smoke', backend: 'memory' },
            family: 'two-agent',
            scenarioKeys: ['a'],
            writeResult: async (result) => {
                if (result.scenarios.some(({ outcome }) => outcome !== 'not-run')) {
                    throw new Error('the disk is full');
                }
            }
        });

        await expect(recorder.runScenario('a', async () => await Promise.reject(failure))).rejects.toBe(failure);
        await expect(recorder.runFamily(async () => await Promise.reject(failure))).rejects.toBe(failure);
    });

    it('does not fail a scenario for an error the family test held before it started', async () => {
        const family = await startFamily();
        family.errors.push({ message: 'an earlier failure' });

        await family.recorder.runScenario('a', async () => {});

        expect(toOutcomes(family.written.at(-1))).toEqual({ a: 'passed', b: 'not-run', c: 'not-run' });
    });
});

describe('the lane result file write', () => {
    it('replaces the file whole, through a file of its own in the same directory, and leaves nothing else', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'alm-lane-result-'));
        try {
            const directory = path.join(root, 'alm-lane-result');
            const plan = { carrier: 'ws', scope: 'smoke', backend: 'memory', families: [] } as const;

            await writeLaneResultFile(directory, 'ws-smoke-plan.json', plan);
            await writeLaneResultFile(directory, 'ws-smoke-plan.json', { ...plan, backend: 'postgres' });

            expect(readdirSync(directory)).toEqual(['ws-smoke-plan.json']);
            expect(JSON.parse(readFileSync(path.join(directory, 'ws-smoke-plan.json'), 'utf8'))).toEqual({
                ...plan,
                backend: 'postgres'
            });
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
