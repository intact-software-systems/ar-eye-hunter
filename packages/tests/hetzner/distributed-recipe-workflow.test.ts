import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const execFileAsync = promisify(execFile);

const parseMajorMinorPatch = (version: string): [number, number, number] => {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
        throw new Error(`Unsupported semver version: ${version}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const versionAtLeast = (version: string, minimum: string): boolean => {
    const parsed = parseMajorMinorPatch(version);
    const min = parseMajorMinorPatch(minimum);
    for (let i = 0; i < parsed.length; i += 1) {
        if (parsed[i] > min[i]) {
            return true;
        }
        if (parsed[i] < min[i]) {
            return false;
        }
    }
    return true;
};

const workflowDispatchInputNames = (workflow: string): string[] => {
    const inputNames: string[] = [];
    let inInputs = false;

    for (const line of workflow.split(/\r?\n/)) {
        if (line === '    inputs:') {
            inInputs = true;
            continue;
        }
        if (inInputs && line.length > 0 && !line.startsWith(' ')) {
            break;
        }
        if (!inInputs) {
            continue;
        }

        const match = line.match(/^      ([A-Za-z0-9_]+):$/);
        if (match) {
            inputNames.push(match[1]);
        }
    }

    return inputNames;
};

describe('Hetzner distributed recipe workflow', () => {
    it('keeps workflow_dispatch inputs within the GitHub Actions limit', async () => {
        const workflowPaths = [
            '.github/workflows/hetzner-distributed-recipe.yml',
            '.github/workflows/hetzner-headless-browsers.yml',
        ];

        for (const workflowPath of workflowPaths) {
            const workflow = await readFile(path.join(repoRoot, workflowPath), 'utf8');
            const inputNames = workflowDispatchInputNames(workflow);

            expect(
                inputNames.length,
                `${workflowPath} workflow_dispatch inputs: ${inputNames.join(', ')}`,
            ).toBeLessThanOrEqual(25);
        }
    });

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

    it('stops headless browsers by default after distributed artifacts and analysis are uploaded', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );

        expect(workflow).toMatch(/stop_after_run:[\s\S]*?default: true/);
        expect(workflow).toMatch(
            /name: Upload distributed analysis[\s\S]*name: Stop headless browsers[\s\S]*if: always\(\) && inputs\.stop_after_run/,
        );
    });

    it('stops existing headless browsers before starting fresh workers for every distributed recipe run', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );

        expect(workflow).toMatch(
            /if bool_enabled "\$\{RALLAR_ROLLOUT_BEFORE_RUN:-0\}"; then[\s\S]*\.\/08-rollout-controller\.sh[\s\S]*fi[\s\S]*\.\/10-stop-headless-workers\.sh \|\| true[\s\S]*RALLAR_WRITE_HEADLESS_ENV=1 \.\/09-start-headless-workers\.sh/,
        );
    });

    it('uses a TLS control URL for distributed-run admin API calls', async () => {
        const workflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh'),
            'utf8',
        );

        expect(script).toContain(
            'RALLAR_CONTROL_HTTP_URL="${RALLAR_CONTROL_HTTP_URL:-https://control.rallar.intactss.com}"',
        );
        expect(script).not.toContain('RALLAR_CONTROL_HTTP_URL="${RALLAR_CONTROL_HTTP_URL:-http://127.0.0.1:5180}"');
        expect(workflow).toContain('RALLAR_CONTROL_HTTP_URL: https://control.rallar.intactss.com');
        expect(workflow).toContain('printf \'RALLAR_CONTROL_HTTP_URL=%s\\n\' "$(quote "${RALLAR_CONTROL_HTTP_URL}")"');
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

    it('installs and executes controller scripts from the logged-in user home directory', async () => {
        const workflowPaths = [
            '.github/workflows/hetzner-distributed-recipe.yml',
            '.github/workflows/hetzner-headless-browsers.yml',
            '.github/workflows/deploy-hetzner-controller.yml',
        ];

        for (const workflowPath of workflowPaths) {
            const workflow = await readFile(path.join(repoRoot, workflowPath), 'utf8');

            expect(workflow).toContain('rallar_script_dir="${HOME}/rallar-controller"');
            expect(workflow).toContain('"${HETZNER_USER}@${HETZNER_HOST}:~/rallar-controller/"');
            expect(workflow).toContain('ln -sf "${rallar_script_dir}/15-logs.sh" /usr/local/bin/rallar-logs');
            expect(workflow).toContain('cd "${HOME}/rallar-controller"');
            expect(workflow).not.toMatch(/\/tmp\/rallar-controller(?:\/|\s|'|"|$)/);
        }
    });

    it('passes browser log level through workflows that start headless workers', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('browser_log_level:');
            expect(workflow).toContain('default: warning');
            expect(workflow).toContain('RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: ${{ inputs.browser_log_level }}');
            expect(workflow).toContain(
                'printf \'RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL}")"',
            );
        }
    });

    it('passes the selected Playwright browser engine through Hetzner workflows and helpers', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );
        const startScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/09-start-headless-workers.sh'),
            'utf8',
        );
        const statusScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/12-status-headless-workers.sh'),
            'utf8',
        );
        const installScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh'),
            'utf8',
        );
        const dispatchScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh'),
            'utf8',
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('browser_engine:');
            expect(workflow).toContain('default: chromium');
            expect(workflow).toContain('- chromium');
            expect(workflow).toContain('- firefox');
            expect(workflow).toContain('- webkit');
            expect(workflow).toContain('RALLAR_BLACK_BOX_BROWSER_ENGINE: ${{ inputs.browser_engine }}');
            expect(workflow).toContain(
                'printf \'RALLAR_BLACK_BOX_BROWSER_ENGINE=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_BROWSER_ENGINE}")"',
            );
        }

        expect(startScript).toContain('RALLAR_BLACK_BOX_BROWSER_ENGINE="${RALLAR_BLACK_BOX_BROWSER_ENGINE:-chromium}"');
        expect(startScript).toContain('validate_browser_engine RALLAR_BLACK_BOX_BROWSER_ENGINE');
        expect(startScript).toContain('RALLAR_BLACK_BOX_BROWSER_ENGINE');
        expect(startScript).toContain('install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}" "${RALLAR_BLACK_BOX_BROWSER_ENGINE}"');
        expect(startScript).toContain('echo "Browser eng.: ${RALLAR_BLACK_BOX_BROWSER_ENGINE}"');

        expect(installScript).toContain('rallar_playwright_normalize_browser');
        expect(installScript).toContain('install_rallar_playwright_browser()');
        expect(installScript).toContain('playwright install-deps "${browser_name}"');
        expect(installScript).toContain('playwright install "${browser_name}"');

        expect(statusScript).toContain('chrome|chromium|firefox|webkit|WebKit|MiniBrowser|rallar-black-box');

        expect(dispatchScript).toContain('--browser-engine <engine>');
        expect(dispatchScript).toContain('BROWSER_ENGINE="chromium"');
        expect(dispatchScript).toContain('normalize_browser_engine');
        expect(dispatchScript).toContain('-f "browser_engine=${BROWSER_ENGINE}"');
    });

    it('passes the selected headless SPA entry through Hetzner workflows and helpers', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-distributed-recipe.yml'),
            'utf8',
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8',
        );
        const startScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/09-start-headless-workers.sh'),
            'utf8',
        );
        const statusScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/12-status-headless-workers.sh'),
            'utf8',
        );
        const dispatchScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/dispatch-distributed-recipe.sh'),
            'utf8',
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('headless_entry:');
            expect(workflow).toContain('default: operator-spa');
            expect(workflow).toContain('RALLAR_BLACK_BOX_HEADLESS_ENTRY: ${{ inputs.headless_entry }}');
            expect(workflow).toContain(
                'printf \'RALLAR_BLACK_BOX_HEADLESS_ENTRY=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_HEADLESS_ENTRY}")"',
            );
        }

        expect(startScript).toContain('RALLAR_BLACK_BOX_HEADLESS_ENTRY');
        expect(startScript).toContain('echo "Entry      : ${RALLAR_BLACK_BOX_HEADLESS_ENTRY:-operator-spa}"');
        expect(statusScript).toContain('echo "Entry      : ${RALLAR_BLACK_BOX_HEADLESS_ENTRY:-operator-spa}"');
        expect(statusScript).toContain('echo "Browser eng.: ${RALLAR_BLACK_BOX_BROWSER_ENGINE:-unknown}"');
        expect(dispatchScript).toContain('--headless-entry <entry>');
        expect(dispatchScript).toContain('HEADLESS_ENTRY="operator-spa"');
        expect(dispatchScript).toContain('normalize_headless_entry');
        expect(dispatchScript).toContain('-f "headless_entry=${HEADLESS_ENTRY}"');
    });

    it('uses a shared lock-aware Playwright browser installer from rollout and headless scripts', async () => {
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
        );
        const headlessScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/09-start-headless-workers.sh'),
            'utf8',
        );

        for (const script of [rolloutScript, headlessScript]) {
            expect(script).toContain('source "${SCRIPT_DIR}/rallar-playwright-install.sh"');
            expect(script).toContain('install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}"');
            expect(script).not.toContain('playwright install-deps chromium');
            expect(script).not.toContain('playwright install chromium');
        }
    });

    it('uses the shared Playwright installer during legacy controller bootstrap', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8',
        );

        expect(script).toContain('source "${SCRIPT_DIR}/rallar-playwright-install.sh"');
        expect(script).toContain('install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}"');
        expect(script).not.toContain('playwright install --with-deps chromium');
    });

    it('derives the headless browser page readiness timeout from the workflow readiness timeout', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/09-start-headless-workers.sh'),
            'utf8',
        );

        expect(script).toContain(
            'RALLAR_BLACK_BOX_READY_TIMEOUT_MS="${RALLAR_BLACK_BOX_READY_TIMEOUT_MS:-$((RALLAR_HEADLESS_READY_TIMEOUT_SECONDS * 1000))}"',
        );
    });

    it('repairs known Deno lockfile drift before the controlled rollout dirty checkout guard', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-rollout-lock-drift-'));
        const checkoutDir = path.join(tmp, 'checkout');
        const denoLock = path.join(checkoutDir, 'apps/api-v1/deno.lock');
        await mkdir(path.dirname(denoLock), { recursive: true });
        await execFileAsync('git', ['init'], { cwd: checkoutDir });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: checkoutDir });
        await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: checkoutDir });
        await writeFile(denoLock, 'clean\n');
        await execFileAsync('git', ['add', 'apps/api-v1/deno.lock'], { cwd: checkoutDir });
        await execFileAsync('git', ['commit', '-m', 'seed deno lock'], { cwd: checkoutDir });
        await writeFile(denoLock, 'dirty\n');

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh');
        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_CHECKOUT_DIR: checkoutDir,
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'repair-known-drift',
            },
        });

        expect(stdout).toContain('repairedKnownDenoLockDrift=true');
        await expect(readFile(denoLock, 'utf8')).resolves.toBe('clean\n');
    });

    it('warms Deno caches without mutating checked-in lockfiles', async () => {
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8',
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
        );

        for (const script of [deployScript, rolloutScript]) {
            expect(script).toContain(
                'deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/api-v1/deno.json"',
            );
            expect(script).toContain(
                'deno cache --frozen --config "${RALLAR_CHECKOUT_DIR}/apps/rallar-black-box-control-server/deno.json"',
            );
            expect(script).not.toContain('deno cache --config "${RALLAR_CHECKOUT_DIR}');
        }
    });

    it('persists control-server snapshots with an atomic temp-file rename', async () => {
        const source = await readFile(
            path.join(repoRoot, 'apps/rallar-black-box-control-server/src/main.ts'),
            'utf8',
        );

        expect(source).toContain('snapshotPersistenceBounds: ControlRunSnapshotBounds');
        expect(source).toContain("RALLAR_BLACK_BOX_SNAPSHOT_PERSIST_EVENTS");
        expect(source).toContain('controlService.snapshot(security.snapshotPersistenceBounds)');
        expect(source).toContain('let snapshotPersistSequence = 0');
        expect(source).toContain('const tempPath = `${path}.tmp-${Deno.pid}-${Date.now()}-${snapshotPersistSequence += 1}`');
        expect(source).toContain('Deno.writeTextFile(tempPath, payload)');
        expect(source).toContain('Deno.rename(tempPath, path)');
        expect(source).not.toContain('Deno.writeTextFile(path, payload)');
    });

    it('installs latest Deno but enforces 2.9.0 as the minimum Hetzner runtime version', async () => {
        const installScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/01-install-runtime.sh'),
            'utf8',
        );
        const deployScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/02-deploy-controller.sh'),
            'utf8',
        );
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/08-rollout-controller.sh'),
            'utf8',
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

    it('accepts newer Deno versions while rejecting versions below the Hetzner minimum', async () => {
        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-deno-runtime.sh');

        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_DENO_RUNTIME_SELF_TEST: 'version-check',
                RALLAR_DENO_SELF_TEST_VERSION: '2.10.0',
                RALLAR_MIN_DENO_VERSION: '2.9.0',
            },
        });
        expect(stdout).toContain('denoVersionOk=true');

        await expect(execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_DENO_RUNTIME_SELF_TEST: 'version-check',
                RALLAR_DENO_SELF_TEST_VERSION: '2.8.2',
                RALLAR_MIN_DENO_VERSION: '2.9.0',
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('Deno 2.9.0 or newer required; found 2.8.2'),
        });
    });

    it('keeps Playwright packages aligned past the Node 24 browser-install hang regression', async () => {
        const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
        const blackBoxPackage = JSON.parse(
            await readFile(path.join(repoRoot, 'apps/rallar-black-box/package.json'), 'utf8'),
        );
        const lock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));

        expect(rootPackage.devDependencies['@playwright/test']).not.toContain('1.59');
        expect(blackBoxPackage.devDependencies.playwright).not.toContain('1.59');
        expect(blackBoxPackage.devDependencies.playwright).not.toBe('^1.32.0');

        const testVersion = lock.packages['node_modules/@playwright/test'].version;
        const playwrightVersion = lock.packages['node_modules/playwright'].version;
        const playwrightCoreVersion = lock.packages['node_modules/playwright-core'].version;

        expect(playwrightVersion).toBe(testVersion);
        expect(playwrightCoreVersion).toBe(testVersion);
        expect(versionAtLeast(testVersion, '1.60.0')).toBe(true);
    });

    it('removes stale Playwright cache locks in the shared installer self-test', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-stale-lock-'));
        const cacheDir = path.join(tmp, 'ms-playwright');
        const lockDir = path.join(cacheDir, '__dirlock');
        await mkdir(lockDir, { recursive: true });
        const oldDate = new Date(Date.now() - 120_000);
        await utimes(lockDir, oldDate, oldDate);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh');
        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'lock-check',
                RALLAR_PLAYWRIGHT_CACHE_DIR: cacheDir,
                RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS: '1',
                RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS: '0',
            },
        });

        expect(stdout).toContain('removed stale Playwright lock');
        await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses fresh Playwright cache locks in the shared installer self-test', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-fresh-lock-'));
        const cacheDir = path.join(tmp, 'ms-playwright');
        const lockDir = path.join(cacheDir, '__dirlock');
        await mkdir(lockDir, { recursive: true });

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh');
        await expect(execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'lock-check',
                RALLAR_PLAYWRIGHT_CACHE_DIR: cacheDir,
                RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS: '600',
                RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS: '0',
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('Playwright lock is not stale yet'),
        });

        await expect(stat(lockDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    });

    it('does not classify ordinary npm worker processes as active Playwright installers', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-process-list-'));
        const processList = path.join(tmp, 'processes.txt');
        await writeFile(processList, [
            '12345 999 npm --workspace apps/rallar-black-box run headless:worker -- --playwright-ready',
            '',
        ].join('\n'));

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh');
        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'process-check',
                RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE: processList,
            },
        });

        expect(stdout).toContain('activeInstaller=false');
    });

    it('classifies stale active Playwright installers before clearing cache locks', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-stale-process-'));
        const processList = path.join(tmp, 'processes.txt');
        await writeFile(processList, [
            '12345 1200 npm --prefix /opt/rallar/ar-eye-hunter exec -- playwright install chromium',
            '',
        ].join('\n'));

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh');
        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'process-check',
                RALLAR_PLAYWRIGHT_ACTIVE_INSTALLER_STALE_SECONDS: '600',
                RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE: processList,
            },
        });

        expect(stdout).toContain('activeInstaller=true');
        expect(stdout).toContain('staleInstaller=12345');
    });

    it('refuses stale lock cleanup when a stale Playwright installer is present and termination is disabled', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-stale-process-lock-'));
        const cacheDir = path.join(tmp, 'ms-playwright');
        const lockDir = path.join(cacheDir, '__dirlock');
        const processList = path.join(tmp, 'processes.txt');
        await mkdir(lockDir, { recursive: true });
        await writeFile(processList, [
            '12345 1200 npm --prefix /opt/rallar/ar-eye-hunter exec -- playwright install chromium',
            '',
        ].join('\n'));
        const oldDate = new Date(Date.now() - 120_000);
        await utimes(lockDir, oldDate, oldDate);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh');
        await expect(execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'lock-check',
                RALLAR_PLAYWRIGHT_CACHE_DIR: cacheDir,
                RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS: '1',
                RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS: '0',
                RALLAR_PLAYWRIGHT_ACTIVE_INSTALLER_STALE_SECONDS: '600',
                RALLAR_PLAYWRIGHT_TERMINATE_STALE_INSTALLER: 'false',
                RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE: processList,
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('Stale Playwright installer detected for'),
        });

        await expect(stat(lockDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    });

    it('runs the Playwright browser install from the checkout directory after switching users', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-install-cwd-'));
        const binDir = path.join(tmp, 'bin');
        const checkoutDir = path.join(tmp, 'checkout');
        const controllerDir = path.join(tmp, 'controller');
        const npmCallsFile = path.join(tmp, 'npm-calls.txt');
        const runuserCwdFile = path.join(tmp, 'runuser-cwd.txt');
        const runuserArgsFile = path.join(tmp, 'runuser-args.txt');
        const fakeNpm = path.join(binDir, 'npm');
        const fakeRunuser = path.join(binDir, 'runuser');
        await mkdir(binDir, { recursive: true });
        await mkdir(checkoutDir);
        await mkdir(controllerDir);
        await writeFile(fakeNpm, [
            '#!/usr/bin/env bash',
            'printf "cwd=%s args=%s\\n" "$PWD" "$*" >> "${FAKE_NPM_CALLS_FILE}"',
            '',
        ].join('\n'));
        await writeFile(fakeRunuser, [
            '#!/usr/bin/env bash',
            'if [[ "${1:-}" != "-u" ]]; then',
            '  echo "expected runuser -u" >&2',
            '  exit 91',
            'fi',
            'shift 2',
            'if [[ "${1:-}" == "--" ]]; then',
            '  shift',
            'fi',
            'printf "%s\\n" "$PWD" > "${FAKE_RUNUSER_CWD_FILE}"',
            'printf "%s\\n" "$*" > "${FAKE_RUNUSER_ARGS_FILE}"',
            'exec "$@"',
            '',
        ].join('\n'));
        await chmod(fakeNpm, 0o755);
        await chmod(fakeRunuser, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/rallar-playwright-install.sh');
        const playwrightUser = process.env.USER || process.env.LOGNAME || 'root';
        const { stdout } = await execFileAsync('bash', [scriptPath], {
            cwd: controllerDir,
            env: {
                ...process.env,
                FAKE_NPM_CALLS_FILE: npmCallsFile,
                FAKE_RUNUSER_ARGS_FILE: runuserArgsFile,
                FAKE_RUNUSER_CWD_FILE: runuserCwdFile,
                PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
                RALLAR_PLAYWRIGHT_CACHE_DIR: path.join(tmp, 'ms-playwright'),
                RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'install-command',
                RALLAR_PLAYWRIGHT_SELF_TEST_CHECKOUT_DIR: checkoutDir,
                RALLAR_PLAYWRIGHT_USER: playwrightUser,
            },
        });

        await expect(readFile(runuserCwdFile, 'utf8')).resolves.toBe(`${checkoutDir}\n`);
        await expect(readFile(runuserArgsFile, 'utf8')).resolves.toContain('playwright install chromium');
        await expect(readFile(npmCallsFile, 'utf8')).resolves.toContain(`cwd=${checkoutDir}`);
        expect(stdout).toContain('selfTestInstall=ok');
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

    it('builds a non-empty distributed-run create request body from the manifest', async () => {
        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh');

        const { stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'create-body',
                RALLAR_DISTRIBUTED_MANIFEST_PATH: path.join(
                    repoRoot,
                    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
                ),
            },
        });

        const body = JSON.parse(stdout);
        expect(body.manifest.distributedRunId).toBe('hetzner-health-2-agent');
        expect(body.manifest.recipes[0].recipe.commands).toHaveLength(2);
    });

    it('preserves failed control POST response bodies for artifact evidence', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-control-post-failure-'));
        const fakeCurl = path.join(tmp, 'curl');
        const outputFile = path.join(tmp, 'post-response.json');
        await writeFile(fakeCurl, [
            '#!/usr/bin/env bash',
            'output=""',
            'while [[ $# -gt 0 ]]; do',
            '  case "$1" in',
            '    -o)',
            '      output="$2"',
            '      shift 2',
            '      ;;',
            '    -w)',
            '      shift 2',
            '      ;;',
            '    *)',
            '      shift',
            '      ;;',
            '  esac',
            'done',
            'printf \'{"error":"bad manifest"}\' > "${output}"',
            'printf "400"',
            '',
        ].join('\n'));
        await chmod(fakeCurl, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh');
        const { stderr, stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
                RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'post-failure',
                RALLAR_DISTRIBUTED_SELF_TEST_OUTPUT_FILE: outputFile,
            },
        });

        expect(stderr).toContain('POST /distributed-runs failed with HTTP 400');
        expect(stderr).toContain('{"error":"bad manifest"}');
        expect(stdout).toContain('saved_body={"error":"bad manifest"}');
        await expect(readFile(outputFile, 'utf8')).resolves.toBe('{"error":"bad manifest"}');
    });

    it('preserves the last valid distributed-run artifact when a later control GET fails', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-control-get-preserve-'));
        const artifactDir = path.join(tmp, 'artifacts');
        await mkdir(artifactDir, { recursive: true });
        await writeFile(path.join(artifactDir, 'distributed-run.json'), JSON.stringify({
            distributedRunId: 'dist-preserve',
            controlRunId: 'run-preserve',
            state: 'running',
        }));

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh');
        const { stderr, stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                RALLAR_DISTRIBUTED_ARTIFACT_DIR: artifactDir,
                RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'get-preserve',
            },
        });

        expect(stderr).toContain('Keeping existing distributed-run.json after failed GET /distributed-runs/dist-preserve');
        expect(stdout).toContain('preservedState=running');
        await expect(readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8'))
            .resolves.toContain('"state":"running"');
    });

    it('preserves failed control POST response bodies as analyzable artifacts', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-control-post-json-evidence-'));
        const fakeCurl = path.join(tmp, 'curl');
        const artifactDir = path.join(tmp, 'artifacts');
        await mkdir(artifactDir, { recursive: true });
        await writeFile(fakeCurl, [
            '#!/usr/bin/env bash',
            'output=""',
            'while [[ $# -gt 0 ]]; do',
            '  case "$1" in',
            '    -o)',
            '      output="$2"',
            '      shift 2',
            '      ;;',
            '    -w)',
            '      shift 2',
            '      ;;',
            '    *)',
            '      shift',
            '      ;;',
            '  esac',
            'done',
            'printf \'{"error":"bad manifest","message":"target policy rejected"}\' > "${output}"',
            'printf "400"',
            '',
        ].join('\n'));
        await chmod(fakeCurl, 0o755);

        const scriptPath = path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh');
        const { stderr, stdout } = await execFileAsync('bash', [scriptPath], {
            env: {
                ...process.env,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
                RALLAR_DISTRIBUTED_ARTIFACT_DIR: artifactDir,
                RALLAR_DISTRIBUTED_SCRIPT_SELF_TEST: 'post-json-evidence',
            },
        });

        expect(stderr).toContain('Saved failed POST /distributed-runs response body to');
        expect(stdout).toContain('postErrorBody={"error":"bad manifest","message":"target policy rejected"}');
        expect(stdout).toContain('postErrorPhase=create');
        await expect(readFile(path.join(artifactDir, 'control-post-create-error.json'), 'utf8'))
            .resolves.toBe('{"error":"bad manifest","message":"target policy rejected"}');
        await expect(readFile(path.join(artifactDir, 'control-post-error-metadata.json'), 'utf8'))
            .resolves.toContain('"responseFile": "control-post-create-error.json"');
        await expect(readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8'))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('writes distributed-run POST snapshots through temp files before replacing evidence', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hetzner/controller/14-run-distributed-recipe.sh'),
            'utf8',
        );

        expect(script).toContain('control_post_json_to_file()');
        expect(script).toMatch(/control_post_json_to_file\s+\\\s+"\/distributed-runs"/);
        expect(script).toMatch(/control_post_json_to_file\s+\\\s+"\/distributed-runs\/\$\{distributed_run_path_id\}\/stage"/);
        expect(script).toMatch(/control_post_json_to_file\s+\\\s+"\/distributed-runs\/\$\{distributed_run_path_id\}\/start"/);
        expect(script).toContain('control_post_error_file_name()');
        expect(script).toContain('control-post-error-metadata.json');
        expect(script).not.toContain('control_post "/distributed-runs" "${create_body}" >"${run_artifact_dir}/distributed-run.json"');
        expect(script).not.toContain('control_post "/distributed-runs/${distributed_run_path_id}/stage" "{}" >"${run_artifact_dir}/distributed-run.json"');
        expect(script).not.toContain('control_post "/distributed-runs/${distributed_run_path_id}/start" "{}" >"${run_artifact_dir}/distributed-run.json"');
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
            'register_before_login=true',
            '-f',
            'headless_entry=operator-spa',
            '-f',
            'browser_engine=chromium',
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
            'stop_after_run=true',
            '-f',
            'ref=feature/distributed-review-fix',
            '-f',
            'run_id=manual-smoke-run',
        ]);
        expect(stdout).toContain('Dispatched hetzner-distributed-recipe.yml');
        expect(stdout).toContain('03-rtc-smoke-2-agent.json');
        expect(stdout).toContain('Mode     : rollout');
        expect(stdout).toContain('Entry    : operator-spa');
        expect(stdout).toContain('Browser  : chromium');
        expect(stdout).toContain('Register : true');
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
        expect(args).toContain('register_before_login=true');
        expect(args).toContain('stop_after_run=true');
        expect(args).toContain('run_id=fast-health');
        expect(stdout).toContain('Mode     : fast');
        expect(stdout).toContain('Register : true');
        expect(stdout).toContain('Stop headless: true');
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
            '--register-before-login',
            'false',
            '--ready-timeout-seconds',
            '45',
            '--terminal-timeout-seconds',
            '90',
            '--stop-after-run',
            'false',
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
        expect(args).toContain('register_before_login=false');
        expect(args).toContain('ready_timeout_seconds=45');
        expect(args).toContain('terminal_timeout_seconds=90');
        expect(args).toContain('stop_after_run=false');
        expect(stdout).toContain('Mode     : custom');
        expect(stdout).toContain('Register : false');
        expect(stdout).toContain('Stop headless: false');
    });

    it('supports keep-headless as an explicit debug opt-out from cleanup', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-keep-headless-gh-'));
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
            '--fast',
            '--keep-headless',
            '--run-id',
            'debug-keep-headless',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('stop_after_run=false');
        expect(args).toContain('run_id=debug-keep-headless');
        expect(stdout).toContain('Stop headless: false');
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

    it('rejects invalid register-before-login inputs before invoking gh', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-invalid-register-gh-'));
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
            '--register-before-login',
            'maybe',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('register_before_login must be a boolean'),
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects invalid stop-after-run inputs before invoking gh', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-dispatch-invalid-stop-gh-'));
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
            '--stop-after-run',
            'maybe',
        ], {
            cwd: repoRoot,
            env: {
                ...process.env,
                FAKE_GH_ARGS_FILE: argsFile,
                PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}`,
            },
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('stop_after_run must be a boolean'),
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
