import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { load } from 'js-yaml';
import {
    describe,
    expect,
    it
} from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

interface WorkflowInput {
    readonly required: boolean;
    readonly default: string;
    readonly type: string;
    readonly options: readonly string[];
}

interface WorkflowStep {
    readonly name?: string;
    readonly uses?: string;
    readonly run?: string;
    readonly if?: string;
    readonly with?: Readonly<Record<string, string | number | boolean>>;
    readonly env?: Readonly<Record<string, string>>;
}

interface WorkflowJob {
    readonly steps?: readonly WorkflowStep[];
    readonly permissions?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
    readonly outputs?: Readonly<Record<string, string>>;
    readonly needs?: string | readonly string[];
    readonly if?: string;
    readonly with?: Readonly<Record<string, string>>;
    readonly 'timeout-minutes'?: number;
}

interface WorkflowJobWithSteps extends WorkflowJob {
    readonly steps: readonly WorkflowStep[];
}

interface Workflow {
    readonly on: {
        readonly workflow_dispatch?: { readonly inputs: Readonly<Record<string, WorkflowInput>>; } | null;
        readonly schedule?: readonly { readonly cron: string; }[];
        readonly pull_request?: { readonly types: readonly string[]; };
    };
    readonly concurrency: { readonly group: string; readonly 'cancel-in-progress': boolean; };
    readonly permissions?: Readonly<Record<string, string>>;
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

describe('pull-request release workflow', () => {
    it('captures RTC-B05 nightly from moving main and publishes only verified artifacts', () => {
        const workflow = readWorkflow('.github/workflows/rtc-performance-observation.yml');
        const source = readJobWithSteps(workflow, 'source');
        const capture = readJobWithSteps(workflow, 'capture');
        const publication = readJobWithSteps(workflow, 'publication');
        const initialize = findStep(capture, 'Initialize recoverable diagnostics');
        const observe = findStep(capture, 'Capture RTC-B05 browser observation');
        const upload = findStep(capture, 'Retain RTC observation output');
        const verify = findStep(publication, 'Verify captured observation');
        const publish = findStep(publication, 'Publish observation pull request');

        expect(workflow.on).toEqual({
            schedule: [{ cron: '17 3 * * *' }],
            workflow_dispatch: null
        });
        expect(workflow.concurrency).toEqual({
            group: 'rtc-b05-performance-observation',
            'cancel-in-progress': false
        });
        expect(capture.permissions).toEqual({ contents: 'read' });
        expect(capture.env).toBeUndefined();
        expect(source.outputs).toBeUndefined();
        expect(source.steps[0]?.run).toContain('refs/heads/main');
        expect(capture.needs).toBe('source');
        expect(capture.steps[0]).toMatchObject({
            uses: 'actions/checkout@v7',
            with: { ref: '${{ github.sha }}', 'fetch-depth': 0 }
        });
        expect(observe.run).toContain('--source-ref=main');
        expect(observe.run).toContain('--github-run-id="$GITHUB_RUN_ID"');
        expect(observe.run).toContain('--github-run-attempt="$GITHUB_RUN_ATTEMPT"');
        expect(observe.run).toContain('$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID');
        expect(observe.run).not.toMatch(/fetch|ls-remote|origin\/main/iu);
        expect(initialize.run).toContain('$RUNNER_TEMP/rtc-observation');
        expect(initialize.run).toContain('$GITHUB_ENV');
        expect(upload).toMatchObject({
            if: '${{ always() }}',
            uses: 'actions/upload-artifact@v7',
            with: { path: '${{ runner.temp }}/rtc-observation' }
        });
        expect(publication.needs).toEqual(['source', 'capture']);
        expect(publication.steps[0]?.with?.ref).toBe('${{ github.sha }}');
        expect(publication.steps[0]?.with?.['persist-credentials']).toBe(false);
        expect(verify.run).toContain('verify-observation');
        expect(publish.run).toContain('npm run pr:delivery -- publish-observation');
        expect(publication.steps.indexOf(publish)).toBeGreaterThan(publication.steps.indexOf(verify));
        expect(publish.env).toEqual({ GH_TOKEN: '${{ secrets.RTC_OBSERVATION_PR_TOKEN }}' });
        expect(publish.run).not.toMatch(/gh\s+pr\s+merge|--admin|git\s+push\s+origin\s+main/iu);
    });

    it.each([
        { mode: 'publish', capture: true, observation: true, baseline: false, diagnostic: false, publication: true },
        { mode: 'baseline', capture: true, observation: false, baseline: true, diagnostic: false, publication: false },
        { mode: 'diagnostic', capture: false, observation: false, baseline: false, diagnostic: true, publication: false },
        { mode: 'invalid', capture: false, observation: false, baseline: false, diagnostic: false, publication: false }
    ])('routes RTC-B06 $mode without allowing branch evidence into publication', (selection) => {
        const workflow = readWorkflow('.github/workflows/rtc-b06-performance-observation.yml');
        const capture = readJobWithSteps(workflow, 'capture');
        const observation = findStep(capture, 'Capture RTC-B06 E3-memory observation');
        const baseline = findStep(capture, 'Capture RTC-B06 governed branch baseline');
        const observationUpload = findStep(capture, 'Retain RTC-B06 observation output');
        const baselineUpload = findStep(capture, 'Retain governed RTC-B06 branch baseline');

        expect(resolveWorkflowModeCondition(capture.if, selection.mode)).toBe(selection.capture);
        expect(resolveWorkflowModeCondition(observation.if, selection.mode)).toBe(selection.observation);
        expect(resolveWorkflowModeCondition(baseline.if, selection.mode)).toBe(selection.baseline);
        expect(resolveWorkflowModeCondition(observationUpload.if, selection.mode)).toBe(selection.observation);
        expect(resolveWorkflowModeCondition(baselineUpload.if, selection.mode)).toBe(selection.baseline);
        expect(resolveWorkflowModeCondition(workflow.jobs.diagnostic.if, selection.mode)).toBe(selection.diagnostic);
        expect(resolveWorkflowModeCondition(workflow.jobs.publication.if, selection.mode)).toBe(selection.publication);
    });

    it.each(['publish', 'baseline'])('retains RTC-B06 %s raw output even after capture failure', (mode) => {
        const capture = readJobWithSteps(readWorkflow('.github/workflows/rtc-b06-performance-observation.yml'), 'capture');
        const observationUpload = findStep(capture, 'Retain RTC-B06 observation output');
        const baselineUpload = findStep(capture, 'Retain governed RTC-B06 branch baseline');

        expect(resolveWorkflowModeCondition(observationUpload.if, mode, false)).toBe(mode === 'publish');
        expect(resolveWorkflowModeCondition(baselineUpload.if, mode, false)).toBe(mode === 'baseline');
    });

    it('offers all RTC-B06 run modes while requiring verified evidence before publication', () => {
        const workflow = readWorkflow('.github/workflows/rtc-b06-performance-observation.yml');
        const capture = readJobWithSteps(workflow, 'capture');
        const publication = readJobWithSteps(workflow, 'publication');
        const verify = findStep(publication, 'Verify captured observation');
        const publish = findStep(publication, 'Publish observation pull request');

        expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
        expect(workflow.on.workflow_dispatch?.inputs.mode.options).toEqual(['publish', 'baseline', 'diagnostic']);
        expect(capture.permissions).toEqual({ contents: 'read' });
        expect(workflow.concurrency).toEqual({ group: 'rtc-b06-performance-observation', 'cancel-in-progress': false });
        expect(workflow.jobs.diagnostic).toMatchObject({
            needs: 'source',
            strategy: { 'fail-fast': false, matrix: { runner: [1, 2, 3] } }
        });
        expect(publication.needs).toEqual(['source', 'capture']);
        expect(publication.steps[0]?.with?.ref).toBe('${{ github.sha }}');
        expect(publication.steps[0]?.with?.['persist-credentials']).toBe(false);
        expect(publication.steps.indexOf(publish)).toBeGreaterThan(publication.steps.indexOf(verify));
        expect(verify.if).toBeUndefined();
        expect(publish.if).toBeUndefined();
        expect(publish.env).toEqual({ GH_TOKEN: '${{ secrets.RTC_OBSERVATION_PR_TOKEN }}' });
    });

    it('runs only for current pull-request changes and cancels only superseded runs of that PR', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');

        expect(workflow.on).toEqual({
            pull_request: {
                // `labeled`/`unlabeled` re-run the gate when the skip-changed-gates label is applied.
                types: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'labeled', 'unlabeled']
            }
        });
        expect(workflow.concurrency).toEqual({
            group: 'branch-release-pr-${{ github.event.pull_request.number }}',
            'cancel-in-progress': true
        });
        expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });

        const group = workflow.concurrency.group;
        expect(resolveConcurrencyGroup(group, 101)).toBe('branch-release-pr-101');
        expect(resolveConcurrencyGroup(group, 101)).not.toBe(resolveConcurrencyGroup(group, 102));
    });

    it('validates the PR source against its event base and preserves one stable required result', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
        const pullRequestHead = '${{ github.event.pull_request.head.sha }}';

        expect(workflow.jobs['governance-gate']?.with).toEqual({ candidate_ref: pullRequestHead });
        // The base is the pull-request base unless the skip-changed-gates label is applied, which
        // passes the empty base the main-push deploy path already uses.
        expect(workflow.jobs['release-gate']?.with?.candidate_ref).toBe(pullRequestHead);
        expect(workflow.jobs['release-gate']?.with?.changed_repo_style_base).toContain(
            'github.event.pull_request.base.sha'
        );
        expect(workflow.jobs['release-gate']?.with?.changed_repo_style_base).toContain(
            'contains(github.event.pull_request.labels.*.name, \'skip-changed-gates\')'
        );
        expect(workflow.jobs['branch-release-result']).toMatchObject({
            name: 'Branch Release Gate result',
            if: '${{ always() }}'
        });
        expect(readJobWithSteps(workflow, 'branch-release-result').steps[0]).toMatchObject({
            uses: 'actions/checkout@v7',
            with: { ref: pullRequestHead }
        });
    });

    it('lets a superseded run cancel every job except the fail-closed result', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');

        for (const jobId of ['release-gate', 'publish-validation-evidence', 'rtc-observation-integrity']) {
            const condition = workflow.jobs[jobId].if;
            expect(condition?.startsWith('${{ !cancelled() && ')).toBe(true);
            expect(condition).not.toContain('always()');
        }
        // GitHub never cancels a job whose condition is still true, and a skipped required job reports
        // success, so only the result job keeps always() and concludes a cancelled run as a failure.
        expect(workflow.jobs['branch-release-result'].if).toBe('${{ always() }}');
    });

    it('keeps ordinary PR validation read-only and independent of apps or tracked evidence', () => {
        const sources = [
            '.github/workflows/branch-release-gate.yml',
            '.github/workflows/governance-gate.yml',
            '.github/workflows/release-gate.yml'
        ].map(readSource);
        const source = sources.join('\n');

        expect(source).not.toMatch(/merge_group|pull_request_target|source approval/iu);
        expect(source).not.toMatch(/GOVERNANCE_APP|APP_PRIVATE_KEY|governance:decide/iu);
        expect(source).not.toMatch(/gh\s+pr\s+(?:comment|edit)|git\s+(?:add|commit|push)/iu);
        expect(source).not.toMatch(/plans\/|governance\/decisions|pr-human-review/iu);
    });
});

function readWorkflow(repositoryPath: string): Workflow {
    return load(readSource(repositoryPath)) as Workflow;
}

function readJobWithSteps(workflow: Workflow, jobId: string): WorkflowJobWithSteps {
    const job = workflow.jobs[jobId];
    if (job === undefined || job.steps === undefined) {
        throw new Error(`Workflow job ${jobId} has no steps.`);
    }
    return { ...job, steps: job.steps };
}

function findStep(job: WorkflowJobWithSteps, name: string): WorkflowStep {
    const step = job.steps.find((entry) => entry.name === name);
    if (step === undefined) {
        throw new Error(`Workflow step ${name} is missing.`);
    }
    return step;
}

function readSource(repositoryPath: string): string {
    return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function resolveConcurrencyGroup(template: string, pullRequestNumber: number): string {
    return template.replace('${{ github.event.pull_request.number }}', String(pullRequestNumber));
}

function resolveWorkflowModeCondition(condition: string | undefined, mode: string, successful = true): boolean {
    if (condition === undefined) {
        return successful;
    }
    const expression = /^\$\{\{([\s\S]+)\}\}$/.exec(condition)?.[1];
    if (expression === undefined) {
        throw new Error(`Workflow condition is not an expression: ${condition}`);
    }
    // GitHub adds success() implicitly unless a status function is present.
    if (!successful && !/\balways\s*\(/u.test(expression)) {
        return false;
    }
    const selected = runInNewContext(expression, { inputs: { mode }, always: () => true });
    if (typeof selected !== 'boolean') {
        throw new Error(`Workflow condition did not return a boolean: ${condition}`);
    }
    return selected;
}
