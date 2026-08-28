import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const deployAfterReleaseGateCondition =
    'if: ${{ always() && !cancelled() && github.ref == \'refs/heads/main\' && (needs.release-gate.result == \'success\' || (github.event_name == \'workflow_dispatch\' && inputs.skip_release_gate == true)) }}';
const denoPreflightCondition =
    'if: ${{ always() && !cancelled() && github.ref == \'refs/heads/main\' && vars.DENO_DEPLOY_ACTIONS_ENABLED == \'true\' && (needs.release-gate.result == \'success\' || (github.event_name == \'workflow_dispatch\' && inputs.skip_release_gate == true)) }}';
const deployDenoAfterPreflightCondition =
    'if: ${{ always() && !cancelled() && github.ref == \'refs/heads/main\' && vars.DENO_DEPLOY_ACTIONS_ENABLED == \'true\' && needs.deno-deploy-preflight.result == \'success\' && (needs.release-gate.result == \'success\' || (github.event_name == \'workflow_dispatch\' && inputs.skip_release_gate == true)) }}';
const releaseGateEnabledCondition =
    'if: ${{ always() && !cancelled() && needs.governance-decision.outputs.decision_only != \'true\' && (github.event_name != \'workflow_dispatch\' || inputs.skip_release_gate != true) }}';

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
    it('runs validation before every main deployment job proceeds', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
        const releaseGateWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );

        expect(workflow).toContain('release-gate:');
        expect(workflow).toContain('name: Release Gate');
        expect(getJobBlock(workflow, 'release-gate')).toContain(
            'uses: ./.github/workflows/release-gate.yml'
        );
        expect(getJobBlock(workflow, 'release-gate')).toContain(releaseGateEnabledCondition);
        expect(releaseGateWorkflow).toContain('postgres:');
        expect(releaseGateWorkflow).toContain('npm ci');
        expect(releaseGateWorkflow).toContain('npx playwright install --with-deps chromium');
        expect(releaseGateWorkflow).toContain('RALLAR_API_CONFIGURATION_PROFILE: prod-in-memory');
        expect(releaseGateWorkflow).not.toContain('RALLAR_AUTH_CREDENTIAL_SECRET:');
        expect(releaseGateWorkflow).toContain('npm run test:ci');
        expect(releaseGateWorkflow).toContain('npm run build:ar-eye-hunter-v1');
        expect(releaseGateWorkflow).toContain('npm run build:relic-hunters-v1');
        expect(releaseGateWorkflow).toContain('npm run build:rallar');
        expect(releaseGateWorkflow).toContain('cd apps/api-v1 && deno task check');
        expect(releaseGateWorkflow).toContain('cd apps/relic-hunter-server-v1 && deno task check');
        expect(releaseGateWorkflow).toContain(
            'cd apps/rallar-black-box-control-server && deno task check'
        );
        expect(releaseGateWorkflow).toContain('npm run db:migrate');
        expect(releaseGateWorkflow.match(/npm run test:postgres:presence-expiry/gu))
            .toHaveLength(2);
        expect(releaseGateWorkflow).toContain('npm run test:rallar:full-stack:postgres:rest');
        expect(releaseGateWorkflow).toContain('npm run test:rallar:full-stack:postgres:control');

        const deployJobs = ['deploy-eye-hunter', 'deploy-relic-web', 'deploy-rallar-kit'];

        for (const jobName of deployJobs) {
            const jobBlock = getJobBlock(workflow, jobName);

            expect(jobBlock).toContain('needs: release-gate');
            expect(jobBlock).toContain(deployAfterReleaseGateCondition);
            expect(workflow.indexOf('  release-gate:\n')).toBeLessThan(
                workflow.indexOf(`  ${jobName}:\n`)
            );
        }

        const denoDeployJobs = ['deploy-api', 'deploy-control-server', 'deploy-relic-api'];

        for (const jobName of denoDeployJobs) {
            const jobBlock = getJobBlock(workflow, jobName);

            expect(jobBlock).toContain('- release-gate');
            expect(jobBlock).toContain('- deno-deploy-preflight');
            expect(jobBlock).toContain(deployDenoAfterPreflightCondition);
            expect(workflow.indexOf('  release-gate:\n')).toBeLessThan(
                workflow.indexOf(`  ${jobName}:\n`)
            );
        }
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

    it('uploads the root Deno workspace to three explicit main-only applications', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
        const rootConfig = JSON.parse(
            await readFile(path.join(repoRoot, 'deno.json'), 'utf8')
        ) as Record<string, unknown>;

        const expectedDeployments = [
            {
                jobName: 'deploy-api',
                configPath: 'apps/api-v1/deno.json',
                organizationName: 'intact-software-systems',
                appName: 'rallar-server'
            },
            {
                jobName: 'deploy-control-server',
                configPath: 'apps/rallar-black-box-control-server/deno.json',
                organizationName: 'intact-software-systems',
                appName: 'rallar-bb-server'
            },
            {
                jobName: 'deploy-relic-api',
                configPath: 'apps/relic-hunter-server-v1/deno.json',
                organizationName: 'intact-software-systems',
                appName: 'relic-hunters'
            }
        ];

        for (const deployment of expectedDeployments) {
            const jobBlock = getJobBlock(workflow, deployment.jobName);

            expect(jobBlock).toContain(deployDenoAfterPreflightCondition);
            expect(jobBlock).toContain('DENO_DEPLOY_TOKEN: ${{ secrets.DENO_DEPLOY_TOKEN }}');
            expect(jobBlock).toContain(
                `deno deploy . --config deno.json --org intact-software-systems --app ${deployment.appName} --prod --json --non-interactive`
            );
            expect(jobBlock).not.toMatch(/deno deploy \. --config apps\//u);

            const config = JSON.parse(
                await readFile(path.join(repoRoot, deployment.configPath), 'utf8')
            ) as {
                deploy?: {
                    org?: string;
                    app?: string;
                    runtime?: {
                        type?: string;
                        entrypoint?: string;
                        cwd?: string;
                    };
                };
            };

            expect(config.deploy?.org).toBe(deployment.organizationName);
            expect(config.deploy?.app).toBe(deployment.appName);
            expect(config.deploy?.runtime).toEqual({
                type: 'dynamic',
                entrypoint: './src/main.ts',
                cwd: '.'
            });
        }

        expect(rootConfig).not.toHaveProperty('deploy');
        expect(workflow).not.toContain('deploy-in-memory-api:');
        expect(workflow).not.toContain('Deno Deploy auto-deploys from GitHub main branch');
    });

    it('serializes deployment and authenticates every Deno application before mutation', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
        const preflight = getJobBlock(workflow, 'deno-deploy-preflight');

        expect(workflow).toContain('concurrency:\n  group: production-deploy-${{ github.repository }}');
        expect(workflow).toContain('cancel-in-progress: false');
        expect(preflight).toContain('needs: release-gate');
        expect(preflight).toContain(denoPreflightCondition);
        expect(preflight).toContain('DENO_DEPLOY_TOKEN: ${{ secrets.DENO_DEPLOY_TOKEN }}');
        expect(preflight).toContain('deno deploy whoami --json --non-interactive');

        for (const appName of ['rallar-server', 'rallar-bb-server', 'relic-hunters']) {
            expect(preflight).toContain(
                `deno deploy apps get --org intact-software-systems --app ${appName} --json --non-interactive`
            );
        }

        expect(preflight).toContain('deno deploy env list');
        expect(preflight).toContain('verify-deno-deploy-api-configuration.mjs');
        expect(preflight).toContain('--target api-v1');
        expect(preflight).toContain('--target relic');
        expect(preflight).not.toContain('cat "$RUNNER_TEMP/rallar-server-environment.json"');
        expect(preflight).not.toContain('cat "$RUNNER_TEMP/relic-hunters-environment.json"');

        for (const jobName of ['deploy-api', 'deploy-control-server', 'deploy-relic-api']) {
            const jobBlock = getJobBlock(workflow, jobName);
            const staleGuardIndex = jobBlock.indexOf('Verify checked out commit is current main');
            const firstMutationIndex = Math.min(
                ...['Prisma migrate deploy', 'run: deno deploy .']
                    .map((marker) => jobBlock.indexOf(marker))
                    .filter((index) => index >= 0)
            );

            expect(staleGuardIndex).toBeGreaterThanOrEqual(0);
            expect(jobBlock).toContain('git fetch --no-tags origin main');
            expect(jobBlock).toContain('Refusing stale production deploy');
            expect(staleGuardIndex).toBeLessThan(firstMutationIndex);
        }
    });

    it('pins every Deno Deploy command away from the 2.9.6 argument duplication regression', async () => {
        const workflow = await readFile(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

        for (
            const jobName of [
                'deno-deploy-preflight',
                'deploy-api',
                'deploy-control-server',
                'deploy-relic-api'
            ]
        ) {
            const jobBlock = getJobBlock(workflow, jobName);

            expect(jobBlock).toContain('deno-version: 2.9.5');
            expect(jobBlock).not.toContain('deno-version: v2.x');
        }
    });

    it('documents provider settings that prevent feature-branch deployment contexts', async () => {
        const runbook = await readFile(path.join(repoRoot, 'docs/production-deployment.md'), 'utf8');

        for (
            const requirement of [
                'Production branch: `main`',
                'Builds for non-production branches: disabled',
                'Disconnect the Deno GitHub integration',
                'Every push to a linked GitHub repository starts a Deno build',
                'source discovery at the repository-root `deno.json`',
                'App-level `deno.json` files remain authoritative for local checks',
                '`DENO_DEPLOY_ACTIONS_ENABLED=false`',
                'Deploy Default Branch',
                '`DENO_DEPLOY_TOKEN`',
                '`DENO_DEPLOY_ACTIONS_ENABLED=true`',
                'Branch Release Gate',
                'configuration drift'
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

    it('keeps the Postgres presence expiry test from rewriting node_modules', async () => {
        const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
            scripts: Record<string, string>;
            devDependencies: Record<string, string>;
        };
        const script = packageJson.scripts['test:postgres:presence-expiry'];

        expect(script).toContain('--node-modules-dir=none');
        expect(script).toContain('--config packages/tests/shared-server/vitest.deno.config.mjs');
        expect(script).not.toContain('--node-modules-dir=auto');
        expect(packageJson.devDependencies.postgres).toBe('^3.4.9');
    });
});
