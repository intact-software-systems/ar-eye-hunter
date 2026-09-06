import { readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('pull-request release workflow', () => {
    it('captures RTC-B05 nightly from moving main and publishes only verified artifacts', () => {
        const workflow = readWorkflow('.github/workflows/rtc-performance-observation.yml');
        const source = workflow.jobs.source;
        const capture = workflow.jobs.capture;
        const publication = workflow.jobs.publication;
        const initialize = capture.steps.find((step: Record<string, any>) => step.name === 'Initialize recoverable diagnostics');
        const observe = capture.steps.find((step: Record<string, any>) => step.name === 'Capture RTC-B05 browser observation');
        const upload = capture.steps.find((step: Record<string, any>) => step.name === 'Retain RTC observation output');
        const verify = publication.steps.find((step: Record<string, any>) => step.name === 'Verify captured observation');
        const publish = publication.steps.find((step: Record<string, any>) => step.name === 'Publish observation pull request');

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
        expect(source.steps[0].run).toContain('refs/heads/main');
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
        expect(publication.steps[0].with.ref).toBe('${{ github.sha }}');
        expect(publication.steps[0].with['persist-credentials']).toBe(false);
        expect(verify.run).toContain('verify-observation');
        expect(publish.run).toContain('npm run pr:delivery -- publish-observation');
        expect(publication.steps.indexOf(publish)).toBeGreaterThan(publication.steps.indexOf(verify));
        expect(publish.env).toEqual({ GH_TOKEN: '${{ secrets.RTC_OBSERVATION_PR_TOKEN }}' });
        expect(publish.run).not.toMatch(/gh\s+pr\s+merge|--admin|git\s+push\s+origin\s+main/iu);

        const workflowSource = readSource('.github/workflows/rtc-performance-observation.yml');
        expect(workflowSource).not.toMatch(/source.*(?:fresh|latest)|compare.*main|pin(?:ned)?/iu);
    });

    it('captures RTC-B06 E3 only by explicit publish dispatch with hermetic memory configuration', () => {
        const workflow = readWorkflow(
            '.github/workflows/rtc-b06-performance-observation.yml'
        );
        const source = workflow.jobs.source;
        const capture = workflow.jobs.capture;
        const publication = workflow.jobs.publication;
        const observe = capture.steps.find(
            (step: Record<string, any>) => step.name === 'Capture RTC-B06 E3-memory observation'
        );
        const upload = capture.steps.find(
            (step: Record<string, any>) => step.name === 'Retain RTC-B06 observation output'
        );
        const verify = publication.steps.find(
            (step: Record<string, any>) => step.name === 'Verify captured observation'
        );
        const publish = publication.steps.find(
            (step: Record<string, any>) => step.name === 'Publish observation pull request'
        );

        expect(workflow.on).toEqual({
            workflow_dispatch: {
                inputs: {
                    mode: {
                        description: 'Choose permanent main evidence or a non-publishing branch diagnostic',
                        required: true,
                        default: 'publish',
                        type: 'choice',
                        options: ['publish', 'diagnostic']
                    }
                }
            }
        });
        expect(workflow.concurrency).toEqual({
            group: 'rtc-b06-performance-observation',
            'cancel-in-progress': false
        });
        expect(source.steps[0].run).toContain('$RUN_MODE" == "publish"');
        expect(source.steps[0].run).toContain('refs/heads/main');
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
        const capture = workflow.jobs.capture;
        const diagnostic = capture.steps.find(
            (step: Record<string, any>) => step.name === 'Exercise RTC-B06 branch candidate'
        );
        const upload = capture.steps.find(
            (step: Record<string, any>) => step.name === 'Retain RTC-B06 diagnostic output'
        );

        expect(diagnostic).toMatchObject({
            if: '${{ inputs.mode == \'diagnostic\' }}'
        });
        expect(diagnostic.run).toContain('npm run test:rallar:full-stack:memory:live-rtc-3');
        expect(diagnostic.run).toContain('-u DATABASE_URL');
        expect(diagnostic.run).toContain('-u RALLAR_ICE_MODE');
        expect(diagnostic.run).toContain('-u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS');
        expect(diagnostic.run).toContain('-u RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK');
        expect(diagnostic.run).toContain('-u RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES');
        expect(diagnostic.run).not.toContain('observe-live-rtc');
        expect(upload).toMatchObject({
            if: '${{ always() && inputs.mode == \'diagnostic\' }}',
            uses: 'actions/upload-artifact@v7',
            with: {
                name: 'rtc-b06-diagnostic-gh${{ github.run_id }}-a${{ github.run_attempt }}',
                path: expect.stringContaining('${{ runner.temp }}/rtc-b06-observation')
            }
        });
        expect(upload.with.path).toContain('apps/rallar-black-box/test-results');
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

        const group = workflow.concurrency.group as string;
        expect(resolveConcurrencyGroup(group, 101)).toBe(resolveConcurrencyGroup(group, 101));
        expect(resolveConcurrencyGroup(group, 101)).not.toBe(resolveConcurrencyGroup(group, 102));
    });

    it('validates the PR source against its event base and preserves one stable required result', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
        const pullRequestHead = '${{ github.event.pull_request.head.sha }}';
        const pullRequestBase = '${{ github.event.pull_request.base.sha }}';

        expect(workflow.jobs['governance-gate'].with).toEqual({ candidate_ref: pullRequestHead });
        // The base is the pull-request base unless the skip-changed-gates label is applied, which
        // passes the empty base the main-push deploy path already uses.
        expect(workflow.jobs['release-gate'].with.candidate_ref).toBe(pullRequestHead);
        expect(workflow.jobs['release-gate'].with.changed_repo_style_base).toContain(
            'github.event.pull_request.base.sha'
        );
        expect(workflow.jobs['release-gate'].with.changed_repo_style_base).toContain(
            'contains(github.event.pull_request.labels.*.name, \'skip-changed-gates\')'
        );
        expect(workflow.jobs['branch-release-result']).toMatchObject({
            name: 'Branch Release Gate result',
            if: '${{ always() }}'
        });
        expect(workflow.jobs['branch-release-result'].steps[0]).toMatchObject({
            uses: 'actions/checkout@v7',
            with: { ref: pullRequestHead }
        });
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

function readWorkflow(repositoryPath: string): Record<string, any> {
    return load(readSource(repositoryPath)) as Record<string, any>;
}

function readSource(repositoryPath: string): string {
    return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function resolveConcurrencyGroup(template: string, pullRequestNumber: number): string {
    return template.replace('${{ github.event.pull_request.number }}', String(pullRequestNumber));
}
