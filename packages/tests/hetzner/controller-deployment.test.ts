import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { TestContext } from 'vitest';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { runOwnedTestProcess, type OwnedTestProcessOutcome } from './owned-test-process.ts';

interface ControllerSelfTestInput {
    readonly scriptPath: string;
    readonly environment: NodeJS.ProcessEnv;
}

const repoRoot = path.resolve(__dirname, '../../..');
const rolloutScriptPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh');

const distributedRunnerWorkflowPath = '.github/workflows/hetzner-distributed-recipe-runner.yml';

async function runControllerSelfTest(context: TestContext, input: ControllerSelfTestInput): Promise<OwnedTestProcessOutcome> {
    return await runOwnedTestProcess(context, { executable: 'bash', args: [input.scriptPath], options: { env: { ...process.env, ...input.environment } } });
}

describe('Hetzner controller contracts and effects', () => {
    it('provides a provider-neutral wait script for externally started control agents', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/16-wait-for-control-agents.sh'),
            'utf8'
        );

        expect(script).toContain('RALLAR_BLACK_BOX_AGENT_START_INDEX');
        expect(script).toContain('control_run_snapshot_url');
        expect(script).toContain(
            'RALLAR_BLACK_BOX_CONTROL_READ_TOKEN="${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN:-${RALLAR_BLACK_BOX_CONTROL_TOKEN:-}}"'
        );
        expect(script).toContain('Authorization: Bearer ${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN}');
        expect(script).toContain('Timed out waiting for external control agents');
        expect(script).not.toContain('systemctl is-active');
    });

    it('writes workflow-provided headless env values when restarting browsers', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        expect(workflow).toMatch(
            /restart\)[\s\S]*RALLAR_WRITE_HEADLESS_ENV=1 \.\/09-start-headless-workers\.sh/
        );
        expect(workflow).toContain(
            'RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: ${{ secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN || secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN }}'
        );
        expect(workflow).toContain(
            'printf \'RALLAR_BLACK_BOX_CONTROL_READ_TOKEN=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN}")"'
        );
        expect(workflow).not.toContain('RALLAR_WRITE_HEADLESS_ENV=0 ./11-restart-headless-workers.sh');
    });

    it('mints per-agent run tokens for regular headless browser starts', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        expect(workflow).toContain('name: Mint per-agent control run tokens');
        expect(workflow).toContain('if: inputs.action == \'start\' || inputs.action == \'restart\'');
        expect(workflow).toContain(
            'RALLAR_BLACK_BOX_CONTROL_AUTH_TOKEN: ${{ secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN || secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN }}'
        );
        expect(workflow).toContain('control_http_url_from_control_url()');
        expect(workflow).toContain(
            'RALLAR_BLACK_BOX_RUN_ID="${RALLAR_BLACK_BOX_RUN_ID:-hetzner-headless-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}}"'
        );
        expect(workflow).toContain('/runs/${encoded_run_id}/agents/${encoded_agent_id}/tokens');
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_${local_index}_CONTROL_TOKEN');
        expect(workflow).toContain(
            'printf \'%s=%s\\n\' "${env_key}" "$(quote "${token}")" >> "${env_file}"'
        );
    });

    it('defaults to a TLS control URL for distributed-run admin API calls', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedRunnerWorkflowPath), 'utf8');
        const script = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'),
            'utf8'
        );

        expect(script).toContain(
            'RALLAR_CONTROL_HTTP_URL="${RALLAR_CONTROL_HTTP_URL:-https://control.rallar.intactss.com}"'
        );
        expect(script).not.toContain(
            'RALLAR_CONTROL_HTTP_URL="${RALLAR_CONTROL_HTTP_URL:-http://127.0.0.1:5180}"'
        );
        expect(workflow).toContain('control_http_url:');
        expect(workflow).toContain('default: https://control.rallar.intactss.com');
        expect(workflow).toContain('RALLAR_CONTROL_HTTP_URL: ${{ inputs.control_http_url }}');
        expect(workflow).toContain(
            'printf \'RALLAR_CONTROL_HTTP_URL=%s\\n\' "$(quote "${RALLAR_CONTROL_HTTP_URL}")"'
        );
    });

    it('configures SSH keepalives for long Hetzner workflow operations', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('Host *');
            expect(workflow).toContain('ServerAliveInterval 30');
            expect(workflow).toContain('ServerAliveCountMax 20');
            expect(workflow).toContain('TCPKeepAlive yes');
        }
    });

    it('installs and executes controller scripts from the logged-in user home directory', async () => {
        const workflowPaths = [
            distributedRunnerWorkflowPath,
            '.github/workflows/hetzner-headless-browsers.yml',
            '.github/workflows/deploy-hetzner-controller.yml'
        ];

        for (const workflowPath of workflowPaths) {
            const workflow = await readFile(path.join(repoRoot, workflowPath), 'utf8');

            expect(workflow).toContain('rallar_script_dir="${HOME}/rallar-controller"');
            expect(workflow).toContain('"${HETZNER_USER}@${HETZNER_HOST}:~/rallar-controller/"');
            expect(workflow).toContain(
                'ln -sf "${rallar_script_dir}/15-logs.sh" /usr/local/bin/rallar-logs'
            );
            expect(workflow).toContain('cd "${HOME}/rallar-controller"');
            expect(workflow).not.toMatch(/\/tmp\/rallar-controller(?:\/|\s|'|"|$)/);
        }
    });

    it('passes and waits on stable headless worker shard agent ranges', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );
        const runnerWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        const script = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/09-start-headless-workers.sh'),
            'utf8'
        );

        expect(workflow).not.toContain('agent_start_index:');
        expect(workflow).toContain(
            'RALLAR_BLACK_BOX_AGENT_START_INDEX: ${{ vars.RALLAR_BLACK_BOX_AGENT_START_INDEX || \'1\' }}'
        );
        expect(runnerWorkflow).not.toContain(
            'RALLAR_BLACK_BOX_AGENT_START_INDEX: ${{ vars.RALLAR_BLACK_BOX_AGENT_START_INDEX || \'1\' }}'
        );
        expect(runnerWorkflow).toContain('RALLAR_BLACK_BOX_AGENT_START_INDEX: \'1\'');
        expect(workflow).toContain(
            'printf \'RALLAR_BLACK_BOX_AGENT_START_INDEX=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_AGENT_START_INDEX}")"'
        );
        expect(runnerWorkflow).toContain(
            'printf \'RALLAR_BLACK_BOX_AGENT_START_INDEX=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_AGENT_START_INDEX}")"'
        );
        expect(script).toContain(
            'RALLAR_BLACK_BOX_AGENT_START_INDEX="${RALLAR_BLACK_BOX_AGENT_START_INDEX:-1}"'
        );
        expect(script).toContain('RALLAR_BLACK_BOX_CONTROL_READ_TOKEN');
        expect(script).toContain(
            'read_token="${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN:-${RALLAR_BLACK_BOX_CONTROL_TOKEN:-}}"'
        );
        expect(script).toContain('curl "${curl_args[@]}" "${snapshot_url}"');
        expect(script).toContain('^RALLAR_BLACK_BOX_AGENT_[0-9]+_(USERNAME|PASSWORD|CONTROL_TOKEN)$');
        expect(script).toContain('RALLAR_BLACK_BOX_AGENT_START_INDEX');
        expect(script).toContain('agent_start="${RALLAR_BLACK_BOX_AGENT_START_INDEX}"');
        expect(script).toContain('agent_end="$((agent_start + expected - 1))"');
        expect(script).toContain('select(.connected == true and (.agentId | startswith($prefix))');
        expect(script).toContain('($ordinal >= $start and $ordinal <= $end)');
    });

    it('repairs known Deno lockfile drift before the controlled rollout dirty checkout guard', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-rollout-lock-drift-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const checkoutDir = path.join(tmp, 'checkout');
        const denoLock = path.join(checkoutDir, 'apps/api-v1/deno.lock');
        await mkdir(path.dirname(denoLock), { recursive: true });
        await runOwnedTestProcess(context, { executable: 'git', args: ['init'], options: { cwd: checkoutDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['config', 'user.email', 'test@example.com'], options: { cwd: checkoutDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['config', 'user.name', 'Test User'], options: { cwd: checkoutDir } });
        await writeFile(denoLock, 'clean\n');
        await runOwnedTestProcess(context, { executable: 'git', args: ['add', 'apps/api-v1/deno.lock'], options: { cwd: checkoutDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['commit', '-m', 'seed deno lock'], options: { cwd: checkoutDir } });
        await writeFile(denoLock, 'dirty\n');
        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: rolloutScriptPath,
            environment: {
                RALLAR_CHECKOUT_DIR: checkoutDir,
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'repair-known-drift'
            }
        });

        expect(stdout).toContain('repairedKnownDenoLockDrift=true');
        await expect(readFile(denoLock, 'utf8')).resolves.toBe('clean\n');
    });

    it('cleans rollout transient disk pressure before installing dependencies', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-rollout-cleanup-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const checkoutDir = path.join(tmp, 'checkout');
        const artifactDir = path.join(tmp, 'distributed-runs');
        const npmCacheDir = path.join(tmp, 'npm-cache');
        const npmLogDir = path.join(tmp, 'npm-logs');
        const controlStateDir = path.join(tmp, 'control-state');
        const playwrightTmpDir = path.join(tmp, 'playwright_chromiumdev_profile-old');
        const viteTempDir = path.join(checkoutDir, 'node_modules/.vite-temp');
        const nodeModulesPackageDir = path.join(checkoutDir, 'node_modules/react');
        const blackBoxDist = path.join(checkoutDir, 'apps/rallar-black-box/dist');
        const headlessDist = path.join(checkoutDir, 'apps/rallar-black-box-headless/dist');

        await mkdir(viteTempDir, { recursive: true });
        await mkdir(nodeModulesPackageDir, { recursive: true });
        await mkdir(blackBoxDist, { recursive: true });
        await mkdir(headlessDist, { recursive: true });
        await mkdir(path.join(artifactDir, 'old-run'), { recursive: true });
        await mkdir(npmCacheDir, { recursive: true });
        await mkdir(npmLogDir, { recursive: true });
        await mkdir(controlStateDir, { recursive: true });
        await mkdir(playwrightTmpDir, { recursive: true });
        await writeFile(path.join(viteTempDir, 'chunk.tmp'), 'temp\n');
        await writeFile(path.join(nodeModulesPackageDir, 'index.js'), 'export default null;\n');
        await writeFile(path.join(blackBoxDist, 'bundle.js'), 'bundle\n');
        await writeFile(path.join(headlessDist, 'headless.js'), 'headless\n');
        await writeFile(path.join(artifactDir, 'old-run/report.json'), '{}\n');
        await writeFile(path.join(npmCacheDir, 'cache-entry'), 'cache\n');
        await writeFile(path.join(npmLogDir, 'debug.log'), 'log\n');
        await writeFile(path.join(controlStateDir, 'control-snapshot.json'), '{}\n');
        await writeFile(path.join(controlStateDir, 'control-snapshot.json.tmp-123'), '{}\n');
        await writeFile(path.join(playwrightTmpDir, 'LOCK'), 'profile\n');
        const rolloutScript = await readFile(rolloutScriptPath, 'utf8');
        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: rolloutScriptPath,
            environment: {
                RALLAR_CHECKOUT_DIR: checkoutDir,
                RALLAR_DISTRIBUTED_ARTIFACT_DIR: artifactDir,
                RALLAR_ROLLOUT_NPM_CACHE_DIR: npmCacheDir,
                RALLAR_ROLLOUT_NPM_LOG_DIR: npmLogDir,
                RALLAR_ROLLOUT_CONTROL_STATE_DIR: controlStateDir,
                RALLAR_ROLLOUT_TMP_DIR: tmp,
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'cleanup-disk-pressure'
            }
        });

        expect(rolloutScript).toMatch(
            /cleanup_rollout_disk_pressure\s+echo "==> Installing npm dependencies"/
        );
        expect(stdout).toContain('cleanedRolloutDiskPressure=true');
        await expect(stat(path.join(checkoutDir, 'node_modules'))).rejects.toThrow();
        await expect(stat(blackBoxDist)).rejects.toThrow();
        await expect(stat(headlessDist)).rejects.toThrow();
        await expect(stat(path.join(artifactDir, 'old-run'))).rejects.toThrow();
        await expect(stat(npmCacheDir)).rejects.toThrow();
        await expect(stat(npmLogDir)).rejects.toThrow();
        await expect(stat(path.join(controlStateDir, 'control-snapshot.json'))).resolves.toBeTruthy();
        await expect(
            stat(path.join(controlStateDir, 'control-snapshot.json.tmp-123'))
        ).rejects.toThrow();
        await expect(stat(playwrightTmpDir)).rejects.toThrow();
    });

    it('checks out exact commit SHAs without treating them as branch pull refs', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-rollout-sha-ref-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const originDir = path.join(tmp, 'origin.git');
        const sourceDir = path.join(tmp, 'source');
        const checkoutDir = path.join(tmp, 'checkout');
        const rolloutScript = await readFile(rolloutScriptPath, 'utf8');

        await runOwnedTestProcess(context, { executable: 'git', args: ['init', '--bare', originDir], options: {} });
        await mkdir(sourceDir, { recursive: true });
        await runOwnedTestProcess(context, { executable: 'git', args: ['init'], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['config', 'user.email', 'test@example.com'], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['config', 'user.name', 'Test User'], options: { cwd: sourceDir } });
        await writeFile(path.join(sourceDir, 'README.md'), 'seed\n');
        await runOwnedTestProcess(context, { executable: 'git', args: ['add', 'README.md'], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['commit', '-m', 'seed'], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['branch', '-M', 'main'], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['remote', 'add', 'origin', originDir], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['push', '-u', 'origin', 'main'], options: { cwd: sourceDir } });
        await runOwnedTestProcess(context, { executable: 'git', args: ['symbolic-ref', 'HEAD', 'refs/heads/main'], options: { cwd: originDir } });
        const { stdout: commitSha } = await runOwnedTestProcess(context, {
            executable: 'git',
            args: ['rev-parse', 'HEAD'],
            options: {
                cwd: sourceDir
            }
        });

        await runOwnedTestProcess(context, { executable: 'git', args: ['clone', originDir, checkoutDir], options: {} });
        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: rolloutScriptPath,
            environment: {
                RALLAR_CHECKOUT_DIR: checkoutDir,
                RALLAR_REPO_REF: commitSha.trim(),
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'checkout-ref'
            }
        });

        expect(stdout).toContain(`checkoutHead=${commitSha.trim()}`);
        expect(stdout).toContain('checkoutBranch=HEAD');
        expect(rolloutScript).toMatch(
            /if is_full_git_sha "\$\{repo_ref\}"; then[\s\S]*checkout --detach "\$\{repo_ref\}"[\s\S]*return[\s\S]*checkout -B "\$\{repo_ref\}" "origin\/\$\{repo_ref\}"/
        );
    });

    it('follows a rewritten remote branch instead of failing the fast-forward of a diverged local one', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-rollout-rewritten-branch-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const originDir = path.join(tmp, 'origin.git');
        const sourceDir = path.join(tmp, 'source');
        const checkoutDir = path.join(tmp, 'checkout');
        const gitIn = (cwd: string, args: readonly string[]) => runOwnedTestProcess(context, { executable: 'git', args: [...args], options: { cwd } });

        await runOwnedTestProcess(context, { executable: 'git', args: ['init', '--bare', originDir], options: {} });
        await mkdir(sourceDir, { recursive: true });
        await gitIn(sourceDir, ['init']);
        await gitIn(sourceDir, ['config', 'user.email', 'test@example.com']);
        await gitIn(sourceDir, ['config', 'user.name', 'Test User']);
        await writeFile(path.join(sourceDir, 'README.md'), 'seed\n');
        await gitIn(sourceDir, ['add', 'README.md']);
        await gitIn(sourceDir, ['commit', '-m', 'seed']);
        await gitIn(sourceDir, ['branch', '-M', 'main']);
        await gitIn(sourceDir, ['remote', 'add', 'origin', originDir]);
        await gitIn(sourceDir, ['push', '-u', 'origin', 'main']);
        await runOwnedTestProcess(context, { executable: 'git', args: ['symbolic-ref', 'HEAD', 'refs/heads/main'], options: { cwd: originDir } });
        await gitIn(sourceDir, ['checkout', '-b', 'feature']);
        await writeFile(path.join(sourceDir, 'README.md'), 'first\n');
        await gitIn(sourceDir, ['commit', '-am', 'first']);
        await gitIn(sourceDir, ['push', '-u', 'origin', 'feature']);

        // The controller rolled out the first version of the branch.
        await runOwnedTestProcess(context, { executable: 'git', args: ['clone', originDir, checkoutDir], options: {} });
        await gitIn(checkoutDir, ['checkout', 'feature']);

        // The branch is rewritten upstream (a rebase), so the local branch no longer fast-forwards.
        await gitIn(sourceDir, ['reset', '--hard', 'main']);
        await writeFile(path.join(sourceDir, 'README.md'), 'rewritten\n');
        await gitIn(sourceDir, ['commit', '-am', 'rewritten']);
        await gitIn(sourceDir, ['push', '--force', 'origin', 'feature']);
        const { stdout: rewrittenSha } = await gitIn(sourceDir, ['rev-parse', 'HEAD']);

        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: rolloutScriptPath,
            environment: {
                RALLAR_CHECKOUT_DIR: checkoutDir,
                RALLAR_REPO_REF: 'feature',
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'checkout-ref'
            }
        });

        expect(stdout).toContain(`checkoutHead=${rewrittenSha.trim()}`);
        expect(stdout).toContain('checkoutBranch=feature');
    });

    it('warms Deno caches without mutating checked-in lockfiles', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );

        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain(
                'deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json"'
            );
            expect(script).toContain(
                'deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json"'
            );
            expect(script).not.toContain('deno cache --config "${RALLAR_CHECKOUT_DIR}');
        }
    });

    it('installs latest Deno but enforces 2.9.0 as the minimum Hetzner runtime version', async () => {
        const installScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/01-install-runtime.sh'),
            'utf8'
        );
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );

        expect(installScript).toContain('source "${SCRIPT_DIR}/rallar-deno-runtime.sh"');
        expect(installScript).toContain('RALLAR_MIN_DENO_VERSION="${RALLAR_MIN_DENO_VERSION:-2.9.0}"');
        expect(installScript).toContain('curl -fsSL https://deno.land/install.sh | sh');
        expect(installScript).toContain('require_rallar_min_deno_version');
        expect(installScript).not.toContain('sh -s "v${RALLAR_MIN_DENO_VERSION}"');
        expect(installScript).not.toContain('sh -s v2.9.0');

        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain('source "${SCRIPT_DIR}/rallar-deno-runtime.sh"');
            expect(script).toMatch(/require_command deno[\s\S]*require_rallar_min_deno_version/);
        }
    });

    it('isolates Ubuntu, NodeSource, and Caddy apt repository profiles', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-apt-profiles-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const ubuntuSource = path.join(tmp, 'ubuntu.sources');
        const nodeSource = path.join(tmp, 'nodesource.list');
        const caddySource = path.join(tmp, 'caddy-stable.list');
        await Promise.all([
            writeFile(ubuntuSource, 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n'),
            writeFile(nodeSource, 'deb https://deb.nodesource.com/node_24.x nodistro main\n'),
            writeFile(
                caddySource,
                'deb https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n'
            )
        ]);

        const scriptPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-apt-sources.sh');
        await runControllerSelfTest(context, {
            scriptPath: scriptPath,
            environment: {
                RALLAR_APT_CADDY_SOURCE_FILE: caddySource,
                RALLAR_APT_NODESOURCE_FILE: nodeSource,
                RALLAR_APT_PROFILE_OUTPUT_DIR: tmp,
                RALLAR_APT_SOURCES_SELF_TEST: 'profiles',
                RALLAR_APT_UBUNTU_SOURCES_FILE: ubuntuSource
            }
        });

        const ubuntuParts = await readdir(path.join(tmp, 'ubuntu.conf.d'));
        const nodeParts = await readdir(path.join(tmp, 'nodesource.conf.d'));
        const caddyParts = await readdir(path.join(tmp, 'caddy.conf.d'));
        expect(ubuntuParts).toEqual(['ubuntu.sources']);
        expect(nodeParts.sort()).toEqual(['nodesource.list', 'ubuntu.sources']);
        expect(caddyParts.sort()).toEqual(['caddy-stable.list', 'ubuntu.sources']);

        const nodeConfig = await readFile(path.join(tmp, 'nodesource.conf'), 'utf8');
        const caddyConfig = await readFile(path.join(tmp, 'caddy.conf'), 'utf8');
        expect(nodeConfig).not.toContain('caddy.conf.d');
        expect(caddyConfig).not.toContain('nodesource.conf.d');
        expect(nodeConfig).toContain('Acquire::Retries "3";');
        expect(caddyConfig).toContain('Acquire::Retries "3";');
    });

    it('accepts newer Deno versions while rejecting versions below the Hetzner minimum', async (context) => {
        const scriptPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-deno-runtime.sh');

        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: scriptPath,
            environment: {
                RALLAR_DENO_RUNTIME_SELF_TEST: 'version-check',
                RALLAR_DENO_SELF_TEST_VERSION: '2.10.0',
                RALLAR_MIN_DENO_VERSION: '2.9.0'
            }
        });
        expect(stdout).toContain('denoVersionOk=true');

        await expect(
            runControllerSelfTest(context, {
                scriptPath: scriptPath,
                environment: {
                    RALLAR_DENO_RUNTIME_SELF_TEST: 'version-check',
                    RALLAR_DENO_SELF_TEST_VERSION: '2.8.2',
                    RALLAR_MIN_DENO_VERSION: '2.9.0'
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('Deno 2.9.0 or newer required; found 2.8.2')
        });
    });

    it('writes and validates a complete deployment-readiness stamp', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-deployment-readiness-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const readinessPath = path.join(tmp, 'deployment-readiness.json');
        const browserRoot = path.join(tmp, 'browsers');
        const browserDir = path.join(browserRoot, 'versions', '1.61.1-chromium-test');
        const { stdout: commitOutput } = await runOwnedTestProcess(context, {
            executable: 'git',
            args: ['rev-parse', 'HEAD'],
            options: {
                cwd: repoRoot
            }
        });
        const commitSha = commitOutput.trim();
        await mkdir(browserDir, { recursive: true });
        await symlink('versions/1.61.1-chromium-test', path.join(browserRoot, 'active'));

        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/rallar-deployment-readiness.sh'
        );
        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: scriptPath,
            environment: {
                RALLAR_BLACK_BOX_BROWSER_ENGINE: 'chromium',
                RALLAR_CHECKOUT_DIR: repoRoot,
                RALLAR_DEPLOYMENT_READINESS_PATH: readinessPath,
                RALLAR_DEPLOYMENT_READINESS_SELF_TEST: 'round-trip',
                RALLAR_DEPLOYMENT_REF: commitSha,
                RALLAR_PLAYWRIGHT_ROOT: browserRoot,
                RALLAR_READINESS_OS_ID: 'ubuntu',
                RALLAR_READINESS_OS_VERSION: '24.04'
            }
        });

        const readiness: unknown = JSON.parse(await readFile(readinessPath, 'utf8'));
        if (!isJsonRecordValue(readiness)) {
            throw new Error('Deployment readiness must be a JSON object.');
        }
        expect(readiness).toEqual({
            schemaVersion: 1,
            deployedCommit: commitSha,
            packageLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            playwrightVersion: '1.61.1',
            browserEngine: 'chromium',
            browserPath: path.join(browserRoot, 'active'),
            browserStatus: 'passed',
            operatingSystemId: 'ubuntu',
            operatingSystemVersion: '24.04',
            apiHealthStatus: 'passed',
            controlHealthStatus: 'passed',
            publicHealthStatus: 'passed',
            verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
        });
        expect(stdout).toContain('deploymentReadiness=valid');

        const invalidValues = [
            ['packageLockSha256', '0'.repeat(64)],
            ['playwrightVersion', '0.0.0'],
            ['browserEngine', 'firefox'],
            ['browserPath', path.join(browserRoot, 'other')],
            ['browserStatus', 'failed'],
            ['operatingSystemId', 'debian'],
            ['operatingSystemVersion', '23.10'],
            ['apiHealthStatus', 'failed'],
            ['controlHealthStatus', 'failed'],
            ['publicHealthStatus', 'failed']
        ] as const;
        for (const [field, value] of invalidValues) {
            await writeFile(readinessPath, `${JSON.stringify({ ...readiness, [field]: value })}\n`);
            await expect(
                runControllerSelfTest(context, {
                    scriptPath: scriptPath,
                    environment: {
                        RALLAR_BLACK_BOX_BROWSER_ENGINE: 'chromium',
                        RALLAR_CHECKOUT_DIR: repoRoot,
                        RALLAR_DEPLOYMENT_READINESS_PATH: readinessPath,
                        RALLAR_DEPLOYMENT_READINESS_SELF_TEST: 'validate',
                        RALLAR_DEPLOYMENT_REF: commitSha,
                        RALLAR_PLAYWRIGHT_ROOT: browserRoot,
                        RALLAR_READINESS_OS_ID: 'ubuntu',
                        RALLAR_READINESS_OS_VERSION: '24.04'
                    }
                }),
                `invalid readiness field ${field}`
            ).rejects.toMatchObject({
                stderr: expect.stringContaining('Deployment readiness stamp does not match')
            });
        }
        await writeFile(readinessPath, `${JSON.stringify(readiness)}\n`);

        await expect(
            runControllerSelfTest(context, {
                scriptPath: scriptPath,
                environment: {
                    RALLAR_BLACK_BOX_BROWSER_ENGINE: 'chromium',
                    RALLAR_CHECKOUT_DIR: repoRoot,
                    RALLAR_DEPLOYMENT_READINESS_PATH: readinessPath,
                    RALLAR_DEPLOYMENT_READINESS_SELF_TEST: 'validate',
                    RALLAR_DEPLOYMENT_REF: '0000000000000000000000000000000000000000',
                    RALLAR_PLAYWRIGHT_ROOT: browserRoot,
                    RALLAR_READINESS_OS_ID: 'ubuntu',
                    RALLAR_READINESS_OS_VERSION: '24.04'
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('Deployment readiness stamp does not match')
        });
    });

    it('exercises controller script helper behavior without contacting Hetzner', async (context) => {
        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/controller/14-run-distributed-recipe.sh'
        );

        const { stdout } = await runControllerSelfTest(context, {
            scriptPath: scriptPath,
            environment: {
                RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: '1'
            }
        });

        expect(stdout).toContain('encoded=run%2Fwith%20space');
        expect(stdout).toContain('safe_artifact=dist-run-with-space');
        expect(stdout).toContain('safe_bundle=events.jsonl');
        expect(stdout).toContain('unsafe_bundle=rejected');
    });
});
