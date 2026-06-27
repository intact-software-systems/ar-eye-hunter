import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const deployAfterReleaseGateCondition =
    "if: ${{ always() && !cancelled() && (needs.release-gate.result == 'success' || (github.event_name == 'workflow_dispatch' && inputs.skip_release_gate == true)) }}";
const releaseGateEnabledCondition =
    "if: ${{ github.event_name != 'workflow_dispatch' || inputs.skip_release_gate != true }}";

function getJobBlock(workflow: string, jobName: string): string {
    const jobStart = workflow.indexOf(`  ${jobName}:\n`);
    expect(jobStart).toBeGreaterThanOrEqual(0);

    const rest = workflow.slice(jobStart);
    const nextJob = rest.slice(`  ${jobName}:\n`.length).match(/\n  [a-z0-9-]+:\n/);
    return nextJob
        ? rest.slice(0, `  ${jobName}:\n`.length + nextJob.index)
        : rest;
}

describe('Deploy workflow release gate', () => {
    it('runs validation before every main deploy job publishes', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/deploy.yml'),
            'utf8',
        );

        expect(workflow).toContain('release-gate:');
        expect(workflow).toContain('name: Release Gate');
        expect(workflow).toContain('postgres:');
        expect(getJobBlock(workflow, 'release-gate')).toContain(
            releaseGateEnabledCondition,
        );
        expect(workflow).toContain('npm ci');
        expect(workflow).toContain('npx playwright install --with-deps chromium');
        expect(workflow).toContain('npm run test:ci');
        expect(workflow).toContain('npm run build:ar-eye-hunter-v1');
        expect(workflow).toContain('npm run build:relic-hunters-v1');
        expect(workflow).toContain('npm run build:rallar');
        expect(workflow).toContain('cd apps/api-v1 && deno task check');
        expect(workflow).toContain('cd apps/relic-hunter-server-v1 && deno task check');
        expect(workflow).toContain('cd apps/rallar-black-box-control-server && deno task check');
        expect(workflow).toContain('npm run db:migrate');
        expect(workflow).toContain('npm run test:postgres:presence-expiry');
        expect(workflow).toContain('npm run test:rallar:full-stack:postgres:rest');
        expect(workflow).toContain('npm run test:rallar:full-stack:postgres:control');

        const deployJobs = [
            'deploy-eye-hunter',
            'deploy-relic-web',
            'deploy-rallar-kit',
            'deploy-api',
            'deploy-in-memory-api',
            'deploy-relic-api',
        ];

        for (const jobName of deployJobs) {
            const jobBlock = getJobBlock(workflow, jobName);

            expect(jobBlock).toContain('needs: release-gate');
            expect(jobBlock).toContain(deployAfterReleaseGateCondition);
            expect(workflow.indexOf('  release-gate:\n')).toBeLessThan(
                workflow.indexOf(`  ${jobName}:\n`),
            );
        }
    });

    it('defaults manual release-gate skipping off while keeping push-to-main deploys gated', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/deploy.yml'),
            'utf8',
        );

        expect(workflow).toContain('push:\n    branches:\n      - main');
        expect(workflow).toContain('workflow_dispatch:\n    inputs:');
        expect(workflow).toContain('skip_release_gate:');
        expect(workflow).toContain('description: "Skip release gate validation for this manual deploy"');
        expect(workflow).toContain('default: false');
        expect(workflow).toContain('type: boolean');
        expect(getJobBlock(workflow, 'release-gate')).toContain(
            releaseGateEnabledCondition,
        );
    });

    it('keeps the Postgres presence expiry test from rewriting node_modules', async () => {
        const packageJson = JSON.parse(
            await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
        ) as {
            scripts: Record<string, string>;
            devDependencies: Record<string, string>;
        };
        const script = packageJson.scripts['test:postgres:presence-expiry'];

        expect(script).toContain('--node-modules-dir=none');
        expect(script).toContain(
            '--config packages/tests/shared-server/vitest.deno.config.mjs',
        );
        expect(script).not.toContain('--node-modules-dir=auto');
        expect(packageJson.devDependencies.postgres).toBe('^3.4.9');
    });
});
