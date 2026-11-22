import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_LANE_JOB_NAME_PATTERN,
    toAlmLaneResultArtifactPrefix
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-workflow-names.ts';
import { toEvaluatedWorkflowText } from './to-evaluated-workflow-text.ts';

interface MatrixEntry {
    readonly carrier: AlmConformanceCarrier;
    readonly families: string;
}

interface NamedStep {
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface NamedWorkflow {
    readonly jobs: Readonly<
        Record<
            string,
            Readonly<{
                name?: string;
                steps?: readonly NamedStep[];
                strategy?: Readonly<{ matrix: Readonly<{ include?: readonly MatrixEntry[]; }>; }>;
            }>
        >
    >;
}

interface UploadAction {
    readonly runs: Readonly<{ steps: readonly Readonly<{ name?: string; with?: Readonly<{ name?: string; }>; }>[]; }>;
}

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function readYaml(relativePath: string): string {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const observation = load(readYaml('.github/workflows/alm-conformance-observation.yml')) as NamedWorkflow;
const results = load(readYaml('.github/actions/alm-conformance-lane-results/action.yml')) as UploadAction;
const lane = observation.jobs['alm-conformance-observation'];
const entries = lane?.strategy?.matrix.include ?? [];

function toMatrixValues(entry: MatrixEntry): Readonly<Record<string, string>> {
    return { 'matrix.carrier': entry.carrier, 'matrix.families': entry.families };
}

/** The names the job's results step uploads under, from the step's own inputs evaluated for the entry. */
function toUploadNames(entry: MatrixEntry): readonly string[] {
    const resultsStep = lane?.steps?.find((step) => step.uses === './.github/actions/alm-conformance-lane-results');
    const inputs = Object.entries(resultsStep?.with ?? {}).map(([input, text]) => [
        `inputs.${input}`,
        toEvaluatedWorkflowText(text, toMatrixValues(entry))
    ]);
    const values = { ...Object.fromEntries(inputs), 'github.sha': 'abc123' };
    return results.runs.steps.map((step) => toEvaluatedWorkflowText(step.with?.name ?? '', values));
}

describe('the names the ALM lane ledger reads from GitHub', () => {
    it.each(entries)('reads the lane job of %j by its name in the workflow', (entry) => {
        const jobName = toEvaluatedWorkflowText(lane?.name ?? '', toMatrixValues(entry));

        expect(ALM_LANE_JOB_NAME_PATTERN.exec(jobName)?.[1]).toBe(entry.carrier);
    });

    it.each(entries)('finds the result artifact of %j by its name in the action', (entry) => {
        const resultName = toUploadNames(entry).find((name) => name.startsWith('alm-lane-result-'));

        expect(resultName?.startsWith(toAlmLaneResultArtifactPrefix(entry.carrier))).toBe(true);
    });

    it('builds a distinct name for every artifact of every job in the matrix', () => {
        const names = entries.flatMap(toUploadNames);

        expect(entries).not.toEqual([]);
        expect(new Set(names).size).toBe(names.length);
    });

    it.each([
        { jobName: 'ALM conformance observation (rtc)', carrier: 'rtc' },
        { jobName: 'ALM conformance observation (rtc, two-agent,addressed)', carrier: 'rtc' },
        { jobName: 'ALM conformance observation (rtc-with-ws-fallback)', carrier: 'rtc-with-ws-fallback' },
        { jobName: 'ALM conformance observation (rtc-with-ws-fallback, four-role)', carrier: 'rtc-with-ws-fallback' },
        { jobName: 'Detect ALM lane changes', carrier: undefined }
    ])('reads $jobName as the job of $carrier', ({ jobName, carrier }) => {
        expect(ALM_LANE_JOB_NAME_PATTERN.exec(jobName)?.[1]).toBe(carrier);
    });
});
