import { readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

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

    it('captures RTC-B06 E3 only by explicit publish dispatch with hermetic memory configuration', () => {
        const workflow = readWorkflow(
            '.github/workflows/rtc-b06-performance-observation.yml'
        );
        const source = readJobWithSteps(workflow, 'source');
        const capture = readJobWithSteps(workflow, 'capture');
        const publication = readJobWithSteps(workflow, 'publication');
        const observe = findStep(capture, 'Capture RTC-B06 E3-memory observation');
        const upload = findStep(capture, 'Retain RTC-B06 observation output');
        const verify = findStep(publication, 'Verify captured observation');
        const publish = findStep(publication, 'Publish observation pull request');

        expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
        expect(workflow.on.workflow_dispatch).toMatchObject({
            inputs: {
                mode: {
                    required: true,
                    default: 'publish',
                    type: 'choice',
                    options: ['publish', 'diagnostic']
                },
                rtc_capture_mode: {
                    required: true,
                    default: 'signaling',
                    type: 'choice',
                    options: ['off', 'signaling', 'native']
                }
            }
        });
        expect(workflow.concurrency).toEqual({
            group: 'rtc-b06-performance-observation',
            'cancel-in-progress': false
        });
        expect(source.steps[0]?.run).toContain('$RUN_MODE" == "publish"');
        expect(source.steps[0]?.run).toContain('refs/heads/main');
        expect(capture['timeout-minutes']).toBe(360);
        expect(observe.if).toBe('${{ inputs.mode == \'publish\' }}');
        expect(observe.run).toContain('observe-live-rtc');
        expect(upload).toMatchObject({
            if: '${{ always() && inputs.mode == \'publish\' }}',
            uses: 'actions/upload-artifact@v7',
            with: {
                name: 'rtc-b06-observation-gh${{ github.run_id }}-a${{ github.run_attempt }}',
                path: '${{ runner.temp }}/rtc-b06-observation'
            }
        });
        expect(verify.run).toContain('verify-observation');
        expect(publication.if).toBe('${{ inputs.mode == \'publish\' }}');
        expect(publication.steps.indexOf(publish)).toBeGreaterThan(
            publication.steps.indexOf(verify)
        );
        expect(publish.env).toEqual({
            GH_TOKEN: '${{ secrets.RTC_OBSERVATION_PR_TOKEN }}'
        });
    });

    it('runs RTC-B06 branch diagnostics without creating publishable observation evidence', () => {
        const workflow = readWorkflow(
            '.github/workflows/rtc-b06-performance-observation.yml'
        );
        const diagnostic = readJobWithSteps(workflow, 'diagnostic');
        const exercise = findStep(diagnostic, 'Exercise RTC-B06 diagnostic cases');
        const upload = findStep(diagnostic, 'Retain RTC-B06 diagnostic output');

        expect(workflow.jobs.capture.if).toBe('${{ inputs.mode == \'publish\' }}');
        expect(diagnostic).toMatchObject({
            if: '${{ inputs.mode == \'diagnostic\' }}',
            needs: 'source',
            strategy: {
                'fail-fast': false,
                matrix: { runner: [1, 2, 3] }
            }
        });
        expect(diagnostic.steps[0]).toMatchObject({
            uses: 'actions/checkout@v7',
            with: { ref: '${{ github.sha }}', 'fetch-depth': 0 }
        });
        expect(exercise.run?.match(/npm run test:rallar:full-stack:memory:live-rtc-3/g))
            .toHaveLength(3);
        expect(exercise.run).toContain('RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1');
        expect(exercise.run).toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1');
        expect(exercise.run).toContain('RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100');
        expect(exercise.run?.match(/--retries=0/g)).toHaveLength(3);
        expect(exercise.run).toContain('set -o pipefail');
        expect(exercise.run).not.toContain('observe-live-rtc');
        expect(upload).toMatchObject({
            if: '${{ always() }}',
            uses: 'actions/upload-artifact@v7',
            with: {
                name: 'rtc-b06-diagnostic-r${{ matrix.runner }}-gh${{ github.run_id }}-a${{ github.run_attempt }}',
                path: '${{ runner.temp }}/rtc-b06-diagnostic-${{ matrix.runner }}'
            }
        });
        expect(diagnostic.steps.some(
            (step) => step.name === 'Capture RTC-B06 E3-memory observation'
        )).toBe(false);
        expect(diagnostic.steps.some(
            (step) => step.name === 'Publish observation pull request'
        )).toBe(false);
        expect(workflow.jobs.publication).toMatchObject({
            if: '${{ inputs.mode == \'publish\' }}',
            needs: ['source', 'capture']
        });
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
        expect(resolveConcurrencyGroup(group, 101)).toBe(resolveConcurrencyGroup(group, 101));
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
