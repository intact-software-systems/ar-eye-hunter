import { load } from 'js-yaml';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';

interface WorkflowStep {
    readonly name?: string;
    readonly id?: string;
    readonly if?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly with?: Readonly<Record<string, string | number>>;
}

interface WorkflowService {
    readonly image: string;
}

interface WorkflowJob {
    readonly name?: string;
    readonly 'continue-on-error'?: boolean;
    readonly 'timeout-minutes'?: number;
    readonly if?: string;
    readonly needs?: string | readonly string[];
    readonly outputs?: Readonly<Record<string, string>>;
    readonly services?: Readonly<Record<string, WorkflowService>>;
    readonly steps?: readonly WorkflowStep[];
    readonly strategy?: Readonly<{ matrix: Readonly<{ carrier?: readonly string[]; }>; }>;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface WorkflowPushTrigger {
    readonly branches?: readonly string[];
    readonly 'paths-ignore'?: readonly string[];
}

interface WorkflowTriggers {
    readonly push?: WorkflowPushTrigger;
    readonly pull_request?: Readonly<{ types: readonly string[]; }>;
}

interface WorkflowConcurrency {
    readonly group: string;
    readonly 'cancel-in-progress': boolean;
}

interface WorkflowDocument {
    readonly concurrency?: WorkflowConcurrency;
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
    readonly on: WorkflowTriggers;
}

interface ActionDocument {
    readonly runs: Readonly<{ steps: readonly WorkflowStep[]; }>;
}

interface AdmissionEvent {
    readonly eventName: 'push' | 'workflow_dispatch' | 'pull_request';
    /** The pull request's draft flag; `null` for an event without a pull request. */
    readonly draft: boolean | null;
    /** The detection job's output; empty when that job was skipped or failed. */
    readonly runFullScope: string;
}

const repoRoot = path.resolve(__dirname, '../../..');
const ALM_LANE_ACTION = './.github/actions/alm-conformance-lane';
const ALM_WORKFLOW = './.github/workflows/alm-conformance-observation.yml';
const NAVIGATION_WORKFLOW = './.github/workflows/navigation-report-observation.yml';
const observation = readWorkflow('.github/workflows/alm-conformance-observation.yml');
const laneSteps = readAction('.github/actions/alm-conformance-lane/action.yml').runs.steps;

describe('ALM conformance lane workflows', () => {
    it('runs the smoke scope as a required Release Gate lane within 20 minutes', () => {
        const lane = readWorkflow('.github/workflows/release-gate.yml').jobs['alm-smoke'];

        expect(lane.strategy?.matrix.carrier).toEqual(ALM_CONFORMANCE_CARRIERS);
        expect(lane['continue-on-error']).toBeUndefined();
        expect(lane['timeout-minutes']).toBe(20);
        expect(lane.steps?.find((step) => step.uses === ALM_LANE_ACTION)?.with?.scope).toBe('smoke');
    });

    it('starts itself on main pushes, ready pull requests and dispatch, beside no other workflow', () => {
        const deploy = readWorkflow('.github/workflows/deploy.yml');

        expect(observation.on.push?.branches).toEqual(['main']);
        expect(observation.on.push?.['paths-ignore']).toEqual(deploy.on.push?.['paths-ignore']);
        expect(observation.on.pull_request?.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
        expect(Object.keys(observation.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
        expect(observation.concurrency).toEqual({
            group: 'alm-conformance-observation-${{ github.event.pull_request.number || github.run_id }}',
            'cancel-in-progress': true
        });
    });

    it('observes the full scope on PostgreSQL at the event\'s own commit', () => {
        const lane = observation.jobs['alm-conformance-observation'];
        const steps = lane.steps ?? [];
        const migration = steps.findIndex((step) => step.run === 'npm run db:migrate');
        const laneStep = steps.findIndex((step) => step.uses === ALM_LANE_ACTION);

        expect(Object.keys(observation.jobs).sort()).toEqual(['alm-changes', 'alm-conformance-observation']);
        expect(lane['continue-on-error']).toBe(true);
        expect(lane['timeout-minutes']).toBe(60);
        expect(lane.needs).toBe('alm-changes');
        expect(lane.services?.postgres.image).toBe('postgres:16');
        expect(readCheckout(lane).with).not.toHaveProperty('ref');
        expect(migration).toBeGreaterThan(-1);
        expect(laneStep).toBeGreaterThan(migration);
        expect(steps[laneStep].with?.scope).toBe('full');
    });

    it('detects the pull request\'s ALM changes from its base and head with the selection command', () => {
        const detection = observation.jobs['alm-changes'];
        const checkout = readCheckout(detection);

        expect(detection.name).toBe('Detect ALM lane changes');
        expect(detection.outputs?.run_full_scope).toBe('${{ steps.detect.outputs.run_full_scope }}');
        expect(checkout.with).not.toHaveProperty('ref');
        expect(checkout.with?.['fetch-depth']).toBe(0);
        expect(detection.steps?.find((step) => step.id === 'detect')?.run).toBe(
            'node scripts/alm-lane-selection.mjs --base "${{ github.event.pull_request.base.sha }}"' +
                ' --head "${{ github.event.pull_request.head.sha }}"'
        );
    });

    it.each(
        [
            { event: { eventName: 'push', draft: null, runFullScope: '' }, detects: false, observes: true },
            { event: { eventName: 'workflow_dispatch', draft: null, runFullScope: '' }, detects: false, observes: true },
            { event: { eventName: 'pull_request', draft: true, runFullScope: '' }, detects: false, observes: false },
            { event: { eventName: 'pull_request', draft: false, runFullScope: 'true' }, detects: true, observes: true },
            { event: { eventName: 'pull_request', draft: false, runFullScope: 'false' }, detects: true, observes: false },
            // A failed detection leaves the output empty, which runs the full scope.
            { event: { eventName: 'pull_request', draft: false, runFullScope: '' }, detects: true, observes: true }
        ] satisfies readonly { event: AdmissionEvent; detects: boolean; observes: boolean; }[]
    )(
        'admits the detection and the observation for %j',
        ({ event, detects, observes }) => {
            const lane = observation.jobs['alm-conformance-observation'];

            expect(lane.if?.startsWith('${{ !cancelled() && ')).toBe(true);
            expect(isAdmitted(observation.jobs['alm-changes'].if, event)).toBe(detects);
            expect(isAdmitted(lane.if, event)).toBe(observes);
        }
    );

    it('leaves the Branch Release Gate and the deploy without an ALM job', () => {
        for (const workflowPath of ['.github/workflows/branch-release-gate.yml', '.github/workflows/deploy.yml']) {
            const jobs = Object.entries(readWorkflow(workflowPath).jobs);

            expect(jobs.filter(([jobId, job]) => jobId.startsWith('alm-') || job.uses === ALM_WORKFLOW), workflowPath)
                .toEqual([]);
        }
    });
});

describe('ALM conformance lane action', () => {
    it.each([
        { scope: 'smoke', refused: false },
        { scope: 'full', refused: false },
        { scope: '', refused: true },
        { scope: 'Smoke', refused: true },
        { scope: 'everything', refused: true }
    ])('refuses a scope other than smoke or full before anything runs: %j', ({ scope, refused }) => {
        const [refusal] = laneSteps;
        // Checked before the script runs, so a misplaced step never starts a lane.
        expect(refusal.name).toBe('Refuse an unknown ALM lane scope');
        const result = spawnSync('bash', ['-e', '-c', refusal.run ?? ''], {
            env: { ...process.env, ALM_LANE_SCOPE: scope },
            encoding: 'utf8'
        });

        expect(refusal.if).toBeUndefined();
        expect(refusal.env?.ALM_LANE_SCOPE).toBe('${{ inputs.scope }}');
        expect(result.status !== 0).toBe(refused);
    });

    it('runs each scope\'s script with Playwright\'s global timeout below its job\'s time limit', () => {
        const smoke = laneSteps.find((step) => step.if === '${{ inputs.scope == \'smoke\' }}');
        const full = laneSteps.find((step) => step.if === '${{ inputs.scope == \'full\' }}');
        const smokeLimit = readWorkflow('.github/workflows/release-gate.yml').jobs['alm-smoke']['timeout-minutes'];
        const fullLimit = observation.jobs['alm-conformance-observation']['timeout-minutes'];

        expect(smoke?.run).toBe('npm run test:rallar:full-stack:memory:alm -- --global-timeout=840000');
        expect(full?.run).toBe('npm run test:rallar:full-stack:postgres:alm -- --global-timeout=3300000');
        expect(840_000).toBeLessThan((smokeLimit ?? 0) * 60_000);
        expect(3_300_000).toBeLessThan((fullLimit ?? 0) * 60_000);
    });

    it('uploads both artifacts with the scope in their names, keeping the output root for seven days', () => {
        const uploads = laneSteps.filter((step) => step.uses === 'actions/upload-artifact@v7');
        const [outputRoot, laneResult] = uploads;

        expect(uploads).toHaveLength(2);
        for (const upload of uploads) {
            expect(upload.if).toBe('always()');
            expect(upload.with?.name).toContain('${{ inputs.scope }}');
            expect(upload.with?.['if-no-files-found']).toBe('ignore');
        }
        expect(outputRoot.with?.path).toBe('apps/rallar-black-box/test-results');
        expect(outputRoot.with?.['retention-days']).toBe(7);
        expect(laneResult.with?.path).toBe('apps/rallar-black-box/test-results/alm-lane-result');
        expect(laneResult.with).not.toHaveProperty('retention-days');
    });
});

describe('navigation report observation workflow', () => {
    it('starts the report beside the Branch Release Gate without making its result wait for it', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
        const report = workflow.jobs['navigation-report-observation'];

        expect(report.uses).toBe(NAVIGATION_WORKFLOW);
        expect(report.with?.candidate_ref).toBe('${{ github.event.pull_request.head.sha }}');
        expect(report.if).toContain('!cancelled()');
        expect(report.if).toContain('outputs.mode == \'broad\'');
        for (const [jobId, job] of Object.entries(workflow.jobs)) {
            expect(toNeeds(job), jobId).not.toContain('navigation-report-observation');
        }
    });

    it('starts the report beside the main deploy without making a deployment wait for it', () => {
        const workflow = readWorkflow('.github/workflows/deploy.yml');
        const report = workflow.jobs['navigation-report-observation'];

        expect(report.uses).toBe(NAVIGATION_WORKFLOW);
        expect(report.with?.candidate_ref).toBe('${{ github.sha }}');
        expect(report.if).toBe('${{ github.event_name != \'workflow_dispatch\' || inputs.skip_release_gate != true }}');
        for (const [jobId, job] of Object.entries(workflow.jobs)) {
            expect(toNeeds(job), jobId).not.toContain('navigation-report-observation');
        }
    });
});

/**
 * Evaluates a job's `if` for one event. Every comparison these conditions make is between values of one type, where
 * the expression language and JavaScript agree; a reference to an absent pull request is never reached.
 */
function isAdmitted(condition: string | undefined, event: AdmissionEvent): boolean {
    const expression = /^\$\{\{([\s\S]+)\}\}$/u.exec(condition ?? '')?.[1];
    if (expression === undefined) {
        throw new Error(`Unsupported condition: ${condition}`);
    }
    return runInNewContext(expression.replace(/needs\.([\w-]+)/gu, 'needs["$1"]'), {
        github: {
            event_name: event.eventName,
            event: event.draft === null ? {} : { pull_request: { draft: event.draft } }
        },
        needs: { 'alm-changes': { outputs: { run_full_scope: event.runFullScope } } },
        cancelled: () => false
    }) === true;
}

function readCheckout(job: WorkflowJob): WorkflowStep {
    const checkout = job.steps?.find((step) => step.uses === 'actions/checkout@v7');
    if (checkout === undefined) {
        throw new Error('The job checks out nothing.');
    }
    return checkout;
}

function readWorkflow(relativePath: string): WorkflowDocument {
    return load(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as WorkflowDocument;
}

function readAction(relativePath: string): ActionDocument {
    return load(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as ActionDocument;
}

function toNeeds(job: WorkflowJob): readonly string[] {
    return typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
}
