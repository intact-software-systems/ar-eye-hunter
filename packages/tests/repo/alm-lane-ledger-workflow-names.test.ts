import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    ALM_LANE_JOB_NAME_PATTERN,
    ALM_LANE_LEDGER_IDENTITY,
    toAlmLaneResultArtifactPrefix
} from '@shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-workflow-names.ts';

interface NamedWorkflow {
    readonly jobs: Readonly<Record<string, Readonly<{ name?: string; }>>>;
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

describe('the names the ALM lane ledger reads from GitHub', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('reads the lane job over %s by its name in the workflow', (carrier) => {
        const name = observation.jobs['alm-conformance-observation']?.name ?? '';

        const jobName = name.replace('${{ matrix.carrier }}', carrier);

        expect(ALM_LANE_JOB_NAME_PATTERN.exec(jobName)?.[1]).toBe(carrier);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('finds the result artifact over %s by its name in the action', (carrier) => {
        const uploads = results.runs.steps.map((step) => step.with?.name ?? '');
        const resultName = uploads.find((name) => name.startsWith('alm-lane-result-')) ?? '';

        const artifactName = resultName
            .replace('${{ inputs.carrier }}', carrier)
            .replace('${{ inputs.scope }}', ALM_LANE_LEDGER_IDENTITY.scope)
            .replace('${{ github.sha }}', 'abc123');

        expect(artifactName.startsWith(toAlmLaneResultArtifactPrefix(carrier))).toBe(true);
    });
});
