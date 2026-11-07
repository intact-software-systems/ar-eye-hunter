import { load } from 'js-yaml';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface DeployWorkflowStep {
    readonly run?: string;
}

interface DeployWorkflowJob {
    readonly uses?: string;
    readonly steps?: readonly DeployWorkflowStep[];
}

interface DeployWorkflow {
    readonly jobs: Readonly<Record<string, DeployWorkflowJob>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const releaseGateEnabledCondition = 'if: ${{ github.event_name != \'workflow_dispatch\' || inputs.skip_release_gate != true }}';

function getJobBlock(workflow: string, jobName: string): string {
    const jobStart = workflow.indexOf(`  ${jobName}:\n`);
    expect(jobStart).toBeGreaterThanOrEqual(0);

    const rest = workflow.slice(jobStart);
    const nextJob = rest.slice(`  ${jobName}:\n`.length).match(/\n  [a-z0-9-]+:\n/);
    if (nextJob?.index === undefined) {
        return rest;
    }
    return rest.slice(0, `  ${jobName}:\n`.length + nextJob.index);
}

describe('Deploy workflow release gate', () => {
    it('runs the shared release gate on every main push before production publishes', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

        // What the reusable gate runs is owned by packages/tests/repo/release-gate-lanes.test.ts.
        expect(workflow).toContain('release-gate:');
        expect(workflow).toContain('name: Release Gate');
        expect(getJobBlock(workflow, 'release-gate')).toContain(
            'uses: ./.github/workflows/release-gate.yml'
        );
        expect(getJobBlock(workflow, 'release-gate')).toContain(releaseGateEnabledCondition);
    });

    it('contains only the branch-control, release-gate, and observation jobs', async () => {
        const workflow = load(
            await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')
        ) as DeployWorkflow;

        expect(Object.keys(workflow.jobs).sort()).toEqual([
            'alm-conformance-observation',
            'cloudflare-branch-controls',
            'release-gate'
        ]);
    });

    it('leaves the web app builds to the Release Gate instead of rebuilding them after it', async () => {
        const workflow = load(
            await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')
        ) as DeployWorkflow;
        const rebuildingJobs = Object.entries(workflow.jobs)
            .filter(([, job]) => (job.steps ?? []).some((step) => /\bnpm (?:install|ci|run build)\b/u.test(step.run ?? '')))
            .map(([jobName]) => jobName);

        expect(workflow.jobs['release-gate'].uses).toBe('./.github/workflows/release-gate.yml');
        expect(rebuildingJobs).toEqual([]);
    });

    it('defaults manual release-gate skipping off while keeping push-to-main deploys gated', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

        expect(workflow).toContain('push:\n    branches:\n      - main');
        expect(workflow).toContain('workflow_dispatch:\n    inputs:');
        expect(workflow).toContain('skip_release_gate:');
        expect(workflow).toContain('Skip release gate validation for this manual deploy');
        expect(workflow).toContain('default: false');
        expect(workflow).toContain('type: boolean');
        expect(getJobBlock(workflow, 'release-gate')).toContain(releaseGateEnabledCondition);
        expect(workflow).not.toContain('pull_request:');
    });

    it('documents Cloudflare branch controls and Hetzner server hosting', async () => {
        const runbook = await readFile(path.join(repoRoot, 'docs/production-deployment.md'), 'utf8');

        for (
            const requirement of [
                'Production branch: `main`',
                'Builds for non-production branches: disabled',
                'Branch Release Gate',
                'configuration drift',
                'Hetzner'
            ]
        ) {
            expect(runbook.replace(/\s+/g, ' ')).toContain(requirement);
        }
    });

    it('enforces Cloudflare branch controls only from main with repository-held credentials', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
        const job = getJobBlock(workflow, 'cloudflare-branch-controls');

        expect(job).toContain('if: ${{ false }}');
        expect(job).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
        expect(job).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
        expect(job).toContain('node scripts/deploy/configure-cloudflare-main-only.mjs --apply');
    });
});
