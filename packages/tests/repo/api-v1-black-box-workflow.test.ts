import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const { load: loadYaml } = require('js-yaml') as {
    load(source: string): unknown;
};

interface ActionDocument {
    readonly inputs?: Readonly<Record<string, Readonly<{ default?: string; }>>>;
    readonly runs?: Readonly<{
        steps?: readonly Readonly<{ run?: string; }>[];
    }>;
}

interface WorkflowStep {
    readonly name?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface WorkflowJob {
    readonly env?: Readonly<Record<string, string>>;
    readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
    readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

const removedApiV1WorkflowOverrides = [
    'ENVIRONMENT',
    'API_BASE_URL',
    'RALLAR_ICE_MODE',
    'AUTH_REGISTRATION_MODE',
    'AUTH_STATIC_CLIENTS_MODE',
    'RALLAR_STATE_STRICT_READ_AUTH'
] as const;

async function readYaml<T>(relativePath: string): Promise<T> {
    const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
    return loadYaml(source) as T;
}

function blackBoxActionStep(workflow: WorkflowDocument, jobName: string): WorkflowStep | undefined {
    return workflow.jobs?.[jobName]?.steps?.find(
        (step) => step.uses === './.github/actions/api-v1-black-box-test'
    );
}

describe('API-v1 black-box workflow', () => {
    it('selects one canonical API profile without repeating profile-owned settings', async () => {
        const workflowJobs = [
            ['.github/workflows/api-v1-black-box.yml', ['postgres', 'topology-replay', 'memory']],
            ['.github/workflows/api-v1-medium-scale-gate.yml', ['medium-scale']],
            ['.github/workflows/api-v1-topology-replay-gate.yml', ['topology-replay']],
            ['.github/workflows/release-gate.yml', ['release-gate']]
        ] as const;

        for (const [workflowPath, jobNames] of workflowJobs) {
            const workflow = await readYaml<WorkflowDocument>(workflowPath);
            for (const jobName of jobNames) {
                const environment = workflow.jobs?.[jobName]?.env;
                expect(environment?.RALLAR_API_CONFIGURATION_PROFILE).toBe('prod-in-memory');
                for (const removedName of removedApiV1WorkflowOverrides) {
                    expect(environment).not.toHaveProperty(removedName);
                }
            }
        }
    });

    it('requires both managed cluster ports and forwards them to the runner', async () => {
        const action = await readYaml<ActionDocument>(
            '.github/actions/api-v1-black-box-test/action.yml'
        );
        const script = action.runs?.steps?.map((step) => step.run ?? '').join('\n') ?? '';

        expect(action.inputs?.['secondary-api-port']).toMatchObject({
            default: ''
        });
        expect(action.inputs?.['tertiary-api-port']).toMatchObject({
            default: ''
        });
        expect(script).toContain('${{ inputs.secondary-api-port }}');
        expect(script).toContain('${{ inputs.tertiary-api-port }}');
        expect(script).toContain('--secondary-port=');
        expect(script).toContain('--tertiary-port=');
    });

    it('starts three Postgres APIs while keeping memory single-server', async () => {
        const workflow = await readYaml<WorkflowDocument>('.github/workflows/api-v1-black-box.yml');

        expect(blackBoxActionStep(workflow, 'postgres')?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082'
        });
        expect(blackBoxActionStep(workflow, 'memory')?.with).not.toHaveProperty('secondary-api-port');
        expect(blackBoxActionStep(workflow, 'memory')?.with).not.toHaveProperty('tertiary-api-port');
        expect(blackBoxActionStep(workflow, 'topology-replay')?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082',
            profile: 'api-v1-black-box-topology-replay'
        });
    });

    it('runs the reusable release gate against three Postgres APIs', async () => {
        const workflow = await readYaml<WorkflowDocument>('.github/workflows/release-gate.yml');
        const blackBoxStep = Object.values(workflow.jobs ?? {})
            .flatMap((job) => job.steps ?? [])
            .find((step) => step.uses === './.github/actions/api-v1-black-box-test');

        expect(blackBoxStep?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082',
            'run-migrations': 'true'
        });
        const topologyReplayStep = Object.values(workflow.jobs ?? {})
            .flatMap((job) => job.steps ?? [])
            .find((step) => step.with?.profile === 'api-v1-black-box-topology-replay');
        expect(topologyReplayStep?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082',
            profile: 'api-v1-black-box-topology-replay'
        });
    });

    it('publishes an exact-SHA topology replay gate with the proof and all four logs', async () => {
        const workflow = await readYaml<WorkflowDocument>(
            '.github/workflows/api-v1-topology-replay-gate.yml'
        );
        const proofStep = blackBoxActionStep(workflow, 'topology-replay');
        const steps = workflow.jobs?.['topology-replay']?.steps ?? [];
        const exactShaStep = steps.find((step) => step.name === 'Record exact checkout SHA');
        const uploadStep = steps.find((step) => step.name === 'Upload exact-SHA artifacts');
        const artifactPath = uploadStep?.with?.path;

        expect(proofStep?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082',
            profile: 'api-v1-black-box-topology-replay'
        });
        expect(exactShaStep).toBeDefined();
        expect(uploadStep?.uses).toBe('actions/upload-artifact@v7');
        expect(uploadStep?.with?.name).toBe('api-v1-topology-replay-${{ github.sha }}');
        expect(typeof artifactPath).toBe('string');
        if (typeof artifactPath !== 'string') {
            throw new Error('The topology replay artifact upload must declare a path.');
        }
        for (
            const required of [
                'validated-sha.txt',
                'validated-tree.txt',
                'rtc-topology-replay-proof.json',
                'api-v1-server.log',
                'api-v1-server-secondary.log',
                'api-v1-server-tertiary.log',
                'api-v1-server-tertiary-restart.log'
            ]
        ) {
            expect(artifactPath).toContain(required);
        }
    });

    it('runs the medium-scale gate against three Postgres APIs and uploads every server log', async () => {
        const workflow = await readYaml<WorkflowDocument>(
            '.github/workflows/api-v1-medium-scale-gate.yml'
        );
        const mediumScaleStep = blackBoxActionStep(workflow, 'medium-scale');
        const exactShaArtifactUploadStep = workflow.jobs?.['medium-scale']?.steps?.find(
            (step) => step.name === 'Upload exact-SHA artifacts'
        );
        const artifactPath = exactShaArtifactUploadStep?.with?.path;

        expect(mediumScaleStep?.with).toMatchObject({
            backend: 'postgres',
            'api-port': '18080',
            'secondary-api-port': '18081',
            'tertiary-api-port': '18082'
        });
        expect(exactShaArtifactUploadStep?.uses).toBe('actions/upload-artifact@v7');
        expect(exactShaArtifactUploadStep?.with?.name).toBe('api-v1-medium-scale-${{ github.sha }}');
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
            'utf8'
        );

        expect(branchReleaseGate).toContain('uses: ./.github/workflows/release-gate.yml');
        expect(branchReleaseGate).not.toContain('./.github/actions/api-v1-black-box-test');
    });
});
