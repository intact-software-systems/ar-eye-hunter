import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const execFileAsync = promisify(execFile);

describe('Hetzner distributed recipe workflow', () => {
    it('encodes remote API path identifiers and separates safe artifact directory names', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh'),
            'utf8',
        );

        expect(script).toContain('urlencode()');
        expect(script).toContain('safe_artifact_dir_name()');
        expect(script).toContain('distributed_run_path_id="$(urlencode "${distributed_run_id}")"');
        expect(script).toContain('control_run_path_id="$(urlencode "${control_run_id}")"');
        expect(script).toContain('run_artifact_name="$(safe_artifact_dir_name "${distributed_run_id}")"');
        expect(script).toContain('"/distributed-runs/${distributed_run_path_id}"');
        expect(script).toContain('"/runs/${control_run_path_id}/events.jsonl"');
        expect(script).not.toContain('"/distributed-runs/${distributed_run_id}"');
        expect(script).not.toContain('"/runs/${control_run_id}/events.jsonl"');
    });

    it('rejects unsafe bundle filenames before writing extracted artifacts', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh'),
            'utf8',
        );

        expect(script).toContain('safe_bundle_file_name()');
        expect(script).toContain('Skipping unsafe bundle file name');
        expect(script).toContain('safe_name="$(safe_bundle_file_name "${file_name}")"');
        expect(script).toContain('>"${run_artifact_dir}/${safe_name}"');
    });

    it('publishes analyzer markdown into the GitHub step summary', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );

        expect(workflow).toContain('name: Publish distributed analysis summary');
        expect(workflow).toContain('cat "${artifact_dir}/analysis/summary.md" >> "${GITHUB_STEP_SUMMARY}"');
        expect(workflow).toContain('cat "${artifact_dir}/analysis/fix-proposal.md" >> "${GITHUB_STEP_SUMMARY}"');
        expect(workflow).toContain('cat "${artifact_dir}/analysis/performance.md" >> "${GITHUB_STEP_SUMMARY}"');
        expect(workflow).toContain('if [[ ! -d "${artifact_dir}" ]]; then');
        expect(workflow).toContain('exit 0');
    });

    it('configures SSH keepalives for long Hetzner workflow operations', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('Host *');
            expect(workflow).toContain('ServerAliveInterval 30');
            expect(workflow).toContain('ServerAliveCountMax 20');
            expect(workflow).toContain('TCPKeepAlive yes');
        }
    });

    it('keeps the GitHub log alive during quiet Playwright browser installs', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/09-start-headless-workers.sh'),
            'utf8',
        );

        expect(script).toContain('run_with_heartbeat()');
        expect(script).toContain('${label} still running at');
        expect(script).toContain('"Rallar Playwright install"');
        expect(script).toContain(
            'run_with_heartbeat "Rallar Playwright install" runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" exec -- playwright install chromium',
        );
    });

    it('installs rollout Playwright browsers into the rallar user cache', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
        );

        expect(script).toContain('run_with_heartbeat()');
        expect(script).toContain(
            'run_with_heartbeat "Playwright Chromium dependency install" npm --prefix "${RALLAR_CHECKOUT_DIR}" exec -- playwright install-deps chromium',
        );
        expect(script).toContain(
            'run_with_heartbeat "Rallar Playwright install" runuser -u rallar -- npm --prefix "${RALLAR_CHECKOUT_DIR}" exec -- playwright install chromium',
        );
        expect(script).not.toContain('playwright install --with-deps chromium');
    });

    it('skips the duplicate headless Playwright install after a successful rollout', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toMatch(
                /\.\/08-rollout-controller\.sh[\s\S]*RALLAR_INSTALL_PLAYWRIGHT=0[\s\S]*export RALLAR_INSTALL_PLAYWRIGHT[\s\S]*RALLAR_WRITE_HEADLESS_ENV=1 \.\/09-start-headless-workers\.sh/,
            );
        }
    });

    it('parses the workflow YAML with the same parser used in verification', async () => {
        const workflowPath = path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml');

        const { stdout } = await execFileAsync('ruby', [
            '-e',
            `require 'yaml'; YAML.load_file('${workflowPath}'); puts 'workflow yaml ok'`,
        ]);

        expect(stdout.trim()).toBe('workflow yaml ok');
    });

    it('exercises controller script helper behavior without contacting Hetzner', async () => {
        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh');

        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: '1',
            },
        });

        expect(stdout).toContain('encoded=run%2Fwith%20space');
        expect(stdout).toContain('safe_artifact=dist-run-with-space');
        expect(stdout).toContain('safe_bundle=events.jsonl');
        expect(stdout).toContain('unsafe_bundle=rejected');
    });

    it('dispatches a checked-in manifest with derived GitHub Action inputs', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-gh-'));
        const fakeGh = path.join(tmp, 'gh');
        const argsFile = path.join(tmp, 'gh-args.txt');
        await writeFile(fakeGh, [
            '#!/usr/bin/env bash',
            'if [[ "$1 $2" == "secret list" ]]; then',
            '  if [[ "${3:-}" == "--env" ]]; then',
            '    printf "%s\\t%s\\n" RALLAR_BLACK_BOX_USERNAME 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_PASSWORD 2026-06-25T00:00:00Z',
            '  else',
            '    printf "%s\\t%s\\n" HETZNER_HOST 2026-06-25T00:00:00Z HETZNER_USER 2026-06-25T00:00:00Z HETZNER_SSH_PRIVATE_KEY 2026-06-25T00:00:00Z HETZNER_KNOWN_HOSTS 2026-06-25T00:00:00Z',
            '  fi',
            '  exit 0',
            'fi',
            'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"',
            '',
        ].join('\n'));
        await chmod(fakeGh, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        const { stdout } = await execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
            '--ref',
            'feature/distributed-review-fix',
            '--run-id',
            'manual smoke/run',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toEqual([
            'workflow',
            'run',
            'hetzner-distributed-recipe.yml',
            '--ref',
            'feature/distributed-review-fix',
            '-f',
            'manifest_path=apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
            '-f',
            'agent_count=2',
            '-f',
            'room_id=hetzner-headless-room',
            '-f',
            'application_id=rallar-server',
            '-f',
            'workspace_id=default',
            '-f',
            'rollout_before_run=true',
            '-f',
            'install_playwright=true',
            '-f',
            'npm_ci=false',
            '-f',
            'wait_for_agents=true',
            '-f',
            'ready_timeout_seconds=120',
            '-f',
            'terminal_timeout_seconds=300',
            '-f',
            'ref=feature/distributed-review-fix',
            '-f',
            'run_id=manual-smoke-run',
        ]);
        expect(stdout).toContain('Dispatched hetzner-distributed-recipe.yml');
        expect(stdout).toContain('03-rtc-smoke-2-agent.json');
        expect(stdout).toContain('Mode     : rollout');
    });

    it('dispatches a fast manifest run without rollout, Playwright install, or npm ci', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-fast-gh-'));
        const fakeGh = path.join(tmp, 'gh');
        const argsFile = path.join(tmp, 'gh-args.txt');
        await writeFile(fakeGh, [
            '#!/usr/bin/env bash',
            'if [[ "$1 $2" == "secret list" ]]; then',
            '  printf "%s\\t%s\\n" HETZNER_HOST 2026-06-25T00:00:00Z HETZNER_USER 2026-06-25T00:00:00Z HETZNER_SSH_PRIVATE_KEY 2026-06-25T00:00:00Z HETZNER_KNOWN_HOSTS 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_USERNAME 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_PASSWORD 2026-06-25T00:00:00Z',
            '  exit 0',
            'fi',
            'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"',
            '',
        ].join('\n'));
        await chmod(fakeGh, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        const { stdout } = await execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
            '--ref',
            'main',
            '--run-id',
            'fast-health',
            '--fast',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('rollout_before_run=false');
        expect(args).toContain('install_playwright=false');
        expect(args).toContain('npm_ci=false');
        expect(args).toContain('wait_for_agents=true');
        expect(args).toContain('ready_timeout_seconds=60');
        expect(args).toContain('terminal_timeout_seconds=180');
        expect(args).toContain('run_id=fast-health');
        expect(stdout).toContain('Mode     : fast');
    });

    it('dispatches custom fast-iteration workflow inputs exactly', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-custom-gh-'));
        const fakeGh = path.join(tmp, 'gh');
        const argsFile = path.join(tmp, 'gh-args.txt');
        await writeFile(fakeGh, [
            '#!/usr/bin/env bash',
            'if [[ "$1 $2" == "secret list" ]]; then',
            '  printf "%s\\t%s\\n" HETZNER_HOST 2026-06-25T00:00:00Z HETZNER_USER 2026-06-25T00:00:00Z HETZNER_SSH_PRIVATE_KEY 2026-06-25T00:00:00Z HETZNER_KNOWN_HOSTS 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_USERNAME 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_PASSWORD 2026-06-25T00:00:00Z',
            '  exit 0',
            'fi',
            'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"',
            '',
        ].join('\n'));
        await chmod(fakeGh, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        const { stdout } = await execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
            '--rollout-before-run',
            'no',
            '--install-playwright',
            'on',
            '--npm-ci',
            'yes',
            '--wait-for-agents',
            '0',
            '--ready-timeout-seconds',
            '45',
            '--terminal-timeout-seconds',
            '90',
            '--run-id',
            'custom-inputs',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('rollout_before_run=false');
        expect(args).toContain('install_playwright=true');
        expect(args).toContain('npm_ci=true');
        expect(args).toContain('wait_for_agents=false');
        expect(args).toContain('ready_timeout_seconds=45');
        expect(args).toContain('terminal_timeout_seconds=90');
        expect(stdout).toContain('Mode     : custom');
    });

    it('rejects invalid timeout inputs before invoking gh', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-invalid-timeout-gh-'));
        const fakeGh = path.join(tmp, 'gh');
        const argsFile = path.join(tmp, 'gh-args.txt');
        await writeFile(fakeGh, [
            '#!/usr/bin/env bash',
            'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"',
            '',
        ].join('\n'));
        await chmod(fakeGh, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        await expect(execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
            '--ready-timeout-seconds',
            '0',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('ready_timeout_seconds must be a positive integer'),
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses dispatch before workflow run when required GitHub secrets are missing', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-missing-secrets-gh-'));
        const fakeGh = path.join(tmp, 'gh');
        const argsFile = path.join(tmp, 'gh-args.txt');
        await writeFile(fakeGh, [
            '#!/usr/bin/env bash',
            'if [[ "$1 $2" == "secret list" ]]; then',
            '  printf "%s\\t%s\\n" HETZNER_HOST 2026-06-25T00:00:00Z HETZNER_USER 2026-06-25T00:00:00Z HETZNER_SSH_PRIVATE_KEY 2026-06-25T00:00:00Z HETZNER_KNOWN_HOSTS 2026-06-25T00:00:00Z',
            '  exit 0',
            'fi',
            'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"',
            '',
        ].join('\n'));
        await chmod(fakeGh, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        await expect(execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('Missing required GitHub secret(s): RALLAR_BLACK_BOX_USERNAME, RALLAR_BLACK_BOX_PASSWORD'),
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses diagnostic manifests unless explicitly allowed', async () => {
        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        await expect(execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/diagnostic/expected-failure-1-agent.json',
        ], {
            cwd: repoRoot,
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('Refusing to dispatch diagnostic manifest'),
        });
    });

    it('allows diagnostic manifests with an explicit opt-in', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-diagnostic-gh-'));
        const fakeGh = path.join(tmp, 'gh');
        const argsFile = path.join(tmp, 'gh-args.txt');
        await writeFile(fakeGh, [
            '#!/usr/bin/env bash',
            'if [[ "$1 $2" == "secret list" ]]; then',
            '  printf "%s\\t%s\\n" HETZNER_HOST 2026-06-25T00:00:00Z HETZNER_USER 2026-06-25T00:00:00Z HETZNER_SSH_PRIVATE_KEY 2026-06-25T00:00:00Z HETZNER_KNOWN_HOSTS 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_USERNAME 2026-06-25T00:00:00Z RALLAR_BLACK_BOX_PASSWORD 2026-06-25T00:00:00Z',
            '  exit 0',
            'fi',
            'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"',
            '',
        ].join('\n'));
        await chmod(fakeGh, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh');
        await execFileAsync('bash', [
            scriptPath,
            'apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json',
            '--allow-diagnostic',
            '--run-id',
            'diagnostic-barrier',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        });

        const args = await readFile(argsFile, 'utf8');
        expect(args).toContain('manifest_path=apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json');
        expect(args).toContain('agent_count=2');
        expect(args).toContain('run_id=diagnostic-barrier');
    });
});
