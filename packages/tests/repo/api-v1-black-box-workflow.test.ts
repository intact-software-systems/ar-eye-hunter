import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const { load: loadYaml } = require('js-yaml') as {
    load(source: string): unknown;
};

type ActionDocument = Readonly<{
    inputs?: Readonly<Record<string, Readonly<{ default?: unknown }>>>;
    runs?: Readonly<{
        steps?: readonly Readonly<{ run?: string }>[];
    }>;
}>;

type WorkflowStep = Readonly<{
    name?: string;
    uses?: string;
    with?: Readonly<Record<string, unknown>>;
}>;

type WorkflowDocument = Readonly<{
    jobs?: Readonly<Record<string, Readonly<{
        steps?: readonly WorkflowStep[];
    }>>>;
}>;

async function readYaml<T>(relativePath: string): Promise<T> {
    const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
    return loadYaml(source) as T;
}

function blackBoxActionStep(
    workflow: WorkflowDocument,
    jobName: string,
): WorkflowStep | undefined {
    return workflow.jobs?.[jobName]?.steps?.find(step =>
        step.uses === './.github/actions/api-v1-black-box-test'
    );
}

describe('API-v1 black-box workflow', () => {
    it('supports an optional secondary managed API port', async () => {
        const action = await readYaml<ActionDocument>(
            '.github/actions/api-v1-black-box-test/action.yml',
        );
        const script = action.runs?.steps?.map(step => step.run ?? '').join('\n') ?? '';

        expect(action.inputs?.['secondary-api-port']).toMatchObject({
            default: '',
        });
        expect(script).toContain('${{ inputs.secondary-api-port }}');
        expect(script).toContain('--secondary-port=');
    });

    it('starts two Postgres APIs while keeping memory single-server', async () => {
        const workflow = await readYaml<WorkflowDocument>(
            '.github/workflows/api-v1-black-box.yml',
        );

        expect(blackBoxActionStep(workflow, 'postgres')?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
        });
        expect(blackBoxActionStep(workflow, 'memory')?.with).not.toHaveProperty(
            'secondary-api-port',
        );
    });

    it('runs the release gate against two Postgres APIs', async () => {
        const workflow = await readYaml<WorkflowDocument>(
            '.github/workflows/release-gate.yml',
        );
        const blackBoxStep = Object.values(workflow.jobs ?? {})
            .flatMap(job => job.steps ?? [])
            .find(step => step.uses === './.github/actions/api-v1-black-box-test');

        expect(blackBoxStep?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
        });
    });
});
