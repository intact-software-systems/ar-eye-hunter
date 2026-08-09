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
    it('requires both managed cluster ports and forwards them to the runner', async () => {
        const action = await readYaml<ActionDocument>(
            '.github/actions/api-v1-black-box-test/action.yml',
        );
        const script = action.runs?.steps?.map(step => step.run ?? '').join('\n') ?? '';

        expect(action.inputs?.['secondary-api-port']).toMatchObject({
            default: '',
        });
        expect(action.inputs?.['tertiary-api-port']).toMatchObject({
            default: '',
        });
        expect(script).toContain('${{ inputs.secondary-api-port }}');
        expect(script).toContain('${{ inputs.tertiary-api-port }}');
        expect(script).toContain('--secondary-port=');
        expect(script).toContain('--tertiary-port=');
    });

    it('starts three Postgres APIs while keeping memory single-server', async () => {
        const workflow = await readYaml<WorkflowDocument>(
            '.github/workflows/api-v1-black-box.yml',
        );

        expect(blackBoxActionStep(workflow, 'postgres')?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082',
        });
        expect(blackBoxActionStep(workflow, 'memory')?.with).not.toHaveProperty(
            'secondary-api-port',
        );
        expect(blackBoxActionStep(workflow, 'memory')?.with).not.toHaveProperty(
            'tertiary-api-port',
        );
    });

    it('runs the reusable release gate against three Postgres APIs', async () => {
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
            'tertiary-api-port': '18082',
        });
    });

    it('runs the medium-scale gate against three Postgres APIs and uploads every server log', async () => {
        const workflow = await readYaml<WorkflowDocument>(
            '.github/workflows/api-v1-medium-scale-gate.yml',
        );
        const mediumScaleStep = blackBoxActionStep(workflow, 'medium-scale');
        const exactShaArtifactUploadStep = workflow.jobs?.['medium-scale']?.steps?.find(
            step => step.name === 'Upload exact-SHA artifacts',
        );
        const artifactPath = exactShaArtifactUploadStep?.with?.path;

        expect(mediumScaleStep?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082',
        });
        expect(exactShaArtifactUploadStep?.uses).toBe('actions/upload-artifact@v7');
        expect(exactShaArtifactUploadStep?.with?.name).toBe(
            'api-v1-medium-scale-${{ github.sha }}',
        );
        expect(typeof artifactPath).toBe('string');

        if (typeof artifactPath !== 'string') {
            throw new Error('The exact-SHA artifact upload must declare a path.');
        }

        expect(artifactPath).toContain('api-v1-server.log');
        expect(artifactPath).toContain('api-v1-server-secondary.log');
        expect(artifactPath).toContain('api-v1-server-tertiary.log');
    });

    it('keeps Branch Release Gate reusing the three-server Release Gate', async () => {
        const branchReleaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/branch-release-gate.yml'),
            'utf8',
        );

        expect(branchReleaseGate).toContain('uses: ./.github/workflows/release-gate.yml');
        expect(branchReleaseGate).not.toContain('./.github/actions/api-v1-black-box-test');
    });
});
