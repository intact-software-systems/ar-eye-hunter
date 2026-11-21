import { load } from 'js-yaml';
import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';

interface WorkflowStep {
    readonly id?: string;
    readonly if?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface WorkflowJob {
    readonly 'continue-on-error'?: boolean;
    readonly if?: string;
    readonly needs?: string | readonly string[];
    readonly services?: Readonly<Record<string, unknown>>;
    readonly steps?: readonly WorkflowStep[];
    readonly strategy?: Readonly<{ matrix: Readonly<Record<string, unknown>>; }>;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface WorkflowTriggers {
    readonly push?: Readonly<{ branches?: readonly string[]; }>;
    readonly workflow_call?: Readonly<{ inputs?: Readonly<Record<string, unknown>>; }>;
    readonly workflow_dispatch?: unknown;
}

interface WorkflowDocument {
    readonly concurrency?: unknown;
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
    readonly on: WorkflowTriggers;
}

interface ActionDocument {
    readonly runs: Readonly<{ steps: readonly WorkflowStep[]; }>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const ALM_WORKFLOW = './.github/workflows/alm-conformance-observation.yml';
const ALM_LANE_ACTION = './.github/actions/alm-conformance-lane';
const NAVIGATION_WORKFLOW = './.github/workflows/navigation-report-observation.yml';

describe('ALM conformance lane workflows', () => {
    it('runs the smoke scope as a required Release Gate lane', () => {
        const lane = readWorkflow('.github/workflows/release-gate.yml').jobs['alm-smoke'];

        expect(lane.strategy?.matrix.carrier).toEqual(ALM_CONFORMANCE_CARRIERS);
        expect(lane['continue-on-error']).toBeUndefined();
        expect(lane.steps?.find((step) => step.uses === ALM_LANE_ACTION)?.with?.scope).toBe('smoke');
    });

    it('observes the full scope on PostgreSQL', () => {
        const workflow = readWorkflow('.github/workflows/alm-conformance-observation.yml');
        const jobs = Object.values(workflow.jobs);
        const [job] = jobs;
        const steps = job.steps ?? [];
        const migration = steps.findIndex((step) => step.run === 'npm run db:migrate');
        const lane = steps.findIndex((step) => step.uses === ALM_LANE_ACTION);

        expect(workflow.on.push?.branches).toEqual(['main']);
        expect(workflow.on).toHaveProperty('workflow_call');
        expect(workflow.on).toHaveProperty('workflow_dispatch');
        expect(workflow.on.workflow_call?.inputs).not.toHaveProperty('alm_scope');
        expect(workflow).not.toHaveProperty('concurrency');
        expect(jobs).toHaveLength(1);
        expect(job['continue-on-error']).toBe(true);
        expect(job.services).toHaveProperty('postgres');
        expect(migration).toBeGreaterThan(-1);
        expect(lane).toBeGreaterThan(migration);
        expect(steps[lane].with?.scope).toBe('full');
    });

    it('runs each scope\'s script and uploads both artifacts with the scope in their names', () => {
        const steps = readAction('.github/actions/alm-conformance-lane/action.yml').runs.steps;
        const commands = steps.map((step) => step.run ?? '');
        const uploads = steps.filter((step) => step.uses === 'actions/upload-artifact@v7');

        expect(commands).toContain('npm run test:rallar:full-stack:memory:alm');
        expect(commands).toContain('npm run test:rallar:full-stack:postgres:alm');
        expect(uploads).toHaveLength(2);
        for (const upload of uploads) {
            expect(upload.if).toBe('always()');
            expect(upload.with?.name).toContain('${{ inputs.scope }}');
        }
    });

    it('starts the full scope beside the Branch Release Gate when the changed paths can change the lane', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
        const observation = workflow.jobs['alm-conformance-observation'];

        expect(observation.uses).toBe(ALM_WORKFLOW);
        expect(observation.with?.candidate_ref).toBe('${{ github.event.pull_request.head.sha }}');
        expect(observation.with).not.toHaveProperty('alm_scope');
        expect(toNeeds(observation)).toContain('alm-changes');
        expect(observation.if).toContain('!cancelled()');
        expect(observation.if).toContain('outputs.mode == \'broad\'');
        expect(observation.if).toContain('run_full_scope != \'false\'');
        expect(toNeeds(workflow.jobs['branch-release-result'])).not.toContain('alm-conformance-observation');
        expect(toNeeds(workflow.jobs['publish-validation-evidence'])).not.toContain('alm-conformance-observation');
    });

    it('fails the detection without an output when the diff fails, so the caller runs the full scope', () => {
        const detection = readWorkflow('.github/workflows/branch-release-gate.yml').jobs['alm-changes'].steps?.find((step) => step.id === 'detect');
        const missingRevision = '0'.repeat(40);
        const script = (detection?.run ?? '').replaceAll(/\$\{\{ github\.event\.pull_request\.(?:base|head)\.sha \}\}/gu, missingRevision);
        const directory = mkdtempSync(path.join(tmpdir(), 'alm-changes-'));
        try {
            const outputPath = path.join(directory, 'output');
            writeFileSync(outputPath, '');
            // GitHub's default run shell is bash -e, without pipefail.
            const result = spawnSync('bash', ['-e', '-c', script], {
                cwd: repoRoot,
                env: { ...process.env, GITHUB_OUTPUT: outputPath },
                encoding: 'utf8'
            });

            expect(script).toContain(missingRevision);
            expect(result.status).not.toBe(0);
            expect(readFileSync(outputPath, 'utf8')).toBe('');
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('leaves the main observation to the workflow\'s own push trigger instead of the deploy', () => {
        const workflow = readWorkflow('.github/workflows/deploy.yml');

        expect(workflow.jobs).not.toHaveProperty('alm-conformance-observation');
    });
});

describe('navigation report observation workflow', () => {
    it('starts the report beside the Branch Release Gate without making its result wait for it', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
        const observation = workflow.jobs['navigation-report-observation'];

        expect(observation.uses).toBe(NAVIGATION_WORKFLOW);
        expect(observation.with?.candidate_ref).toBe('${{ github.event.pull_request.head.sha }}');
        expect(observation.if).toContain('!cancelled()');
        expect(observation.if).toContain('outputs.mode == \'broad\'');
        for (const [jobId, job] of Object.entries(workflow.jobs)) {
            expect(toNeeds(job), jobId).not.toContain('navigation-report-observation');
        }
    });

    it('starts the report beside the main deploy without making a deployment wait for it', () => {
        const workflow = readWorkflow('.github/workflows/deploy.yml');
        const observation = workflow.jobs['navigation-report-observation'];

        expect(observation.uses).toBe(NAVIGATION_WORKFLOW);
        expect(observation.with?.candidate_ref).toBe('${{ github.sha }}');
        expect(observation.if).toBe('${{ github.event_name != \'workflow_dispatch\' || inputs.skip_release_gate != true }}');
        for (const [jobId, job] of Object.entries(workflow.jobs)) {
            expect(toNeeds(job), jobId).not.toContain('navigation-report-observation');
        }
    });
});

function readWorkflow(relativePath: string): WorkflowDocument {
    return load(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as WorkflowDocument;
}

function readAction(relativePath: string): ActionDocument {
    return load(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as ActionDocument;
}

function toNeeds(job: WorkflowJob): readonly string[] {
    return typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
}
