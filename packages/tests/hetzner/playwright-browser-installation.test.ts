import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { runOwnedTestProcess } from './owned-test-process.ts';

interface BrowserInstallerToolsInput {
    readonly label: string;
    readonly npmSource: string;
    /** Absent when smoke validation uses the successful executable. */
    readonly nodeSource?: string;
    /** Absent when the test needs the ordinary user-switch invocation. */
    readonly runuserSource?: string;
}

interface BrowserInstallerTools {
    readonly directory: string;
    readonly binDirectory: string;
    readonly checkoutDirectory: string;
    readonly environment: NodeJS.ProcessEnv;
}

const repoRoot = path.resolve(__dirname, '../../..');
const browserInstallerPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-playwright-install.sh');

const distributedWorkflowPath = '.github/workflows/hetzner-distributed-recipe.yml';

const distributedRunnerWorkflowPath = '.github/workflows/hetzner-distributed-recipe-runner.yml';

function readPackageString(value: unknown, keys: readonly string[]): string {
    let field = value;
    for (const key of keys) {
        if (!isJsonRecordValue(field)) {
            throw new Error('Package metadata requires an object at ' + key);
        }
        field = field[key];
    }
    if (typeof field !== 'string') {
        throw new Error('Package metadata requires a string at ' + keys.join('.'));
    }
    return field;
}

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

async function createBrowserInstallerTools(input: BrowserInstallerToolsInput): Promise<BrowserInstallerTools> {
    const directory = await mkdtemp(path.join(tmpdir(), input.label));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const binDirectory = path.join(directory, 'bin');
    const checkoutDirectory = path.join(directory, 'checkout');
    await mkdir(binDirectory);
    await mkdir(checkoutDirectory);
    await writeFile(path.join(checkoutDirectory, 'package-lock.json'), '{}');
    const tools = [
        ['npm', input.npmSource],
        ['node', input.nodeSource ?? '#!/usr/bin/env bash\nexit 0\n'],
        ['runuser', input.runuserSource ?? ['#!/usr/bin/env bash', 'shift 2', '[[ "${1:-}" == "--" ]] && shift', 'exec "$@"', ''].join('\n')]
    ];
    for (const [name, source] of tools) {
        const executablePath = path.join(binDirectory, name);
        await writeFile(executablePath, source);
        await chmod(executablePath, 0o755);
    }
    return {
        directory,
        binDirectory,
        checkoutDirectory,
        environment: {
            ...process.env,
            PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
            RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'install-command',
            RALLAR_PLAYWRIGHT_ROOT: path.join(directory, 'browsers'),
            RALLAR_PLAYWRIGHT_SELF_TEST_CHECKOUT_DIR: checkoutDirectory,
            RALLAR_PLAYWRIGHT_USER: process.env.USER || process.env.LOGNAME || 'root'
        }
    };
}

describe('Hetzner browser contracts and effects', () => {
    it('passes the selected Playwright browser engine through Hetzner workflows and helpers', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );
        const startScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/09-start-headless-workers.sh'),
            'utf8'
        );
        const statusScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/12-status-headless-workers.sh'),
            'utf8'
        );
        const installScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-playwright-install.sh'),
            'utf8'
        );
        const dispatchScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/dispatch-distributed-recipe.sh'),
            'utf8'
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('browser_engine:');
            expect(workflow).toContain('default: chromium');
            expect(workflow).toContain('RALLAR_BLACK_BOX_BROWSER_ENGINE: ${{ inputs.browser_engine }}');
            expect(workflow).toContain(
                'printf \'RALLAR_BLACK_BOX_BROWSER_ENGINE=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_BROWSER_ENGINE}")"'
            );
        }
        for (
            const workflow of [
                await readFile(path.join(repoRoot, distributedWorkflowPath), 'utf8'),
                headlessWorkflow
            ]
        ) {
            expect(workflow).toContain('- chromium');
            expect(workflow).toContain('- firefox');
            expect(workflow).toContain('- webkit');
        }

        expect(startScript).toContain(
            'RALLAR_BLACK_BOX_BROWSER_ENGINE="${RALLAR_BLACK_BOX_BROWSER_ENGINE:-chromium}"'
        );
        expect(startScript).toContain('validate_browser_engine RALLAR_BLACK_BOX_BROWSER_ENGINE');
        expect(startScript).toContain('RALLAR_BLACK_BOX_BROWSER_ENGINE');
        expect(startScript).toContain(
            'install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}" "${RALLAR_BLACK_BOX_BROWSER_ENGINE}"'
        );
        expect(startScript).toContain('echo "Browser eng.: ${RALLAR_BLACK_BOX_BROWSER_ENGINE}"');

        expect(installScript).toContain('rallar_playwright_normalize_browser');
        expect(installScript).toContain('install_rallar_playwright_browser()');
        expect(installScript).toContain('playwright install-deps "${browser_name}"');
        expect(installScript).toContain('playwright install "${browser_name}"');

        expect(statusScript).toContain(
            'chrome|chromium|firefox|webkit|WebKit|MiniBrowser|rallar-black-box'
        );

        expect(dispatchScript).toContain('--browser-engine <engine>');
        expect(dispatchScript).toContain('BROWSER_ENGINE="chromium"');
        expect(dispatchScript).toContain('normalize_browser_engine');
        expect(dispatchScript).toContain('-f "browser_engine=${BROWSER_ENGINE}"');
    });

    it('passes the selected headless SPA entry through Hetzner workflows and helpers', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );
        const startScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/09-start-headless-workers.sh'),
            'utf8'
        );
        const statusScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/12-status-headless-workers.sh'),
            'utf8'
        );
        const dispatchScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/dispatch-distributed-recipe.sh'),
            'utf8'
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('headless_entry:');
            expect(workflow).toContain('default: headless');
            expect(workflow).toContain('RALLAR_BLACK_BOX_HEADLESS_ENTRY: ${{ inputs.headless_entry }}');
            expect(workflow).toContain(
                'printf \'RALLAR_BLACK_BOX_HEADLESS_ENTRY=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_HEADLESS_ENTRY}")"'
            );
        }

        expect(startScript).toContain('RALLAR_BLACK_BOX_HEADLESS_ENTRY');
        expect(startScript).toContain(
            'echo "Entry      : ${RALLAR_BLACK_BOX_HEADLESS_ENTRY:-headless}"'
        );
        expect(statusScript).toContain(
            'echo "Entry      : ${RALLAR_BLACK_BOX_HEADLESS_ENTRY:-headless}"'
        );
        expect(statusScript).toContain(
            'echo "Browser eng.: ${RALLAR_BLACK_BOX_BROWSER_ENGINE:-unknown}"'
        );
        expect(dispatchScript).toContain('--headless-entry <entry>');
        expect(dispatchScript).toContain('HEADLESS_ENTRY="headless"');
        expect(dispatchScript).toContain('normalize_headless_entry');
        expect(dispatchScript).toContain('-f "headless_entry=${HEADLESS_ENTRY}"');
    });

    it('uses a shared lock-aware Playwright browser installer from rollout and headless scripts', async () => {
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );
        const headlessScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/09-start-headless-workers.sh'),
            'utf8'
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
            path.join(repoRoot, 'scripts/hosted-rallar/controller/02-deploy-controller.sh'),
            'utf8'
        );

        expect(script).toContain('source "${SCRIPT_DIR}/rallar-playwright-install.sh"');
        expect(script).toContain('install_rallar_playwright_browser "${RALLAR_CHECKOUT_DIR}"');
        expect(script).not.toContain('playwright install --with-deps chromium');
    });

    it('derives the headless browser page readiness timeout from the workflow readiness timeout', async () => {
        const script = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/09-start-headless-workers.sh'),
            'utf8'
        );

        expect(script).toContain(
            'RALLAR_BLACK_BOX_READY_TIMEOUT_MS="${RALLAR_BLACK_BOX_READY_TIMEOUT_MS:-$((RALLAR_HEADLESS_READY_TIMEOUT_SECONDS * 1000))}"'
        );
    });

    it('keeps Playwright packages aligned past the Node 24 browser-install hang regression', async () => {
        const rootPackage: unknown = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
        const blackBoxPackage: unknown = JSON.parse(
            await readFile(path.join(repoRoot, 'apps/rallar-black-box/package.json'), 'utf8')
        );
        const lock: unknown = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));

        expect(readPackageString(rootPackage, ['devDependencies', '@playwright/test'])).not.toContain('1.59');
        expect(readPackageString(blackBoxPackage, ['devDependencies', 'playwright'])).not.toContain('1.59');
        expect(readPackageString(blackBoxPackage, ['devDependencies', 'playwright'])).not.toBe('^1.32.0');

        const testVersion = readPackageString(lock, ['packages', 'node_modules/@playwright/test', 'version']);
        const playwrightVersion = readPackageString(lock, ['packages', 'node_modules/playwright', 'version']);
        const playwrightCoreVersion = readPackageString(lock, ['packages', 'node_modules/playwright-core', 'version']);

        expect(playwrightVersion).toBe(testVersion);
        expect(playwrightCoreVersion).toBe(testVersion);
        expect(versionAtLeast(testVersion, '1.60.0')).toBe(true);
    });

    it('removes stale Playwright cache locks in the shared installer self-test', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-stale-lock-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const cacheDir = path.join(tmp, 'ms-playwright');
        const lockDir = path.join(cacheDir, '__dirlock');
        await mkdir(lockDir, { recursive: true });
        const oldDate = new Date(Date.now() - 120_000);
        await utimes(lockDir, oldDate, oldDate);
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'lock-check',
                    RALLAR_PLAYWRIGHT_CACHE_DIR: cacheDir,
                    RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS: '1',
                    RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS: '0'
                }
            }
        });

        expect(stdout).toContain('removed stale Playwright lock');
        await expect(stat(lockDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses fresh Playwright cache locks in the shared installer self-test', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-fresh-lock-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const cacheDir = path.join(tmp, 'ms-playwright');
        const lockDir = path.join(cacheDir, '__dirlock');
        await mkdir(lockDir, { recursive: true });
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [browserInstallerPath],
                options: {
                    env: {
                        ...process.env,
                        RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'lock-check',
                        RALLAR_PLAYWRIGHT_CACHE_DIR: cacheDir,
                        RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS: '600',
                        RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS: '0'
                    }
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('Playwright lock is not stale yet')
        });

        await expect(stat(lockDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    });

    it('does not classify ordinary npm worker processes as active Playwright installers', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-process-list-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const processList = path.join(tmp, 'processes.txt');
        await writeFile(
            processList,
            [
                '12345 999 npm --workspace apps/rallar-black-box run headless:worker -- --playwright-ready',
                ''
            ].join('\n')
        );
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'process-check',
                    RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE: processList
                }
            }
        });

        expect(stdout).toContain('activeInstaller=false');
    });

    it('classifies stale active Playwright installers before clearing cache locks', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-stale-process-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const processList = path.join(tmp, 'processes.txt');
        await writeFile(
            processList,
            [
                '12345 1200 npm --prefix /opt/rallar/ar-eye-hunter exec -- playwright install chromium',
                ''
            ].join('\n')
        );
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                env: {
                    ...process.env,
                    RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'process-check',
                    RALLAR_PLAYWRIGHT_ACTIVE_INSTALLER_STALE_SECONDS: '600',
                    RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE: processList
                }
            }
        });

        expect(stdout).toContain('activeInstaller=true');
        expect(stdout).toContain('staleInstaller=12345');
    });

    it('refuses stale lock cleanup when a stale Playwright installer is present and termination is disabled', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-playwright-stale-process-lock-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const cacheDir = path.join(tmp, 'ms-playwright');
        const lockDir = path.join(cacheDir, '__dirlock');
        const processList = path.join(tmp, 'processes.txt');
        await mkdir(lockDir, { recursive: true });
        await writeFile(
            processList,
            [
                '12345 1200 npm --prefix /opt/rallar/ar-eye-hunter exec -- playwright install chromium',
                ''
            ].join('\n')
        );
        const oldDate = new Date(Date.now() - 120_000);
        await utimes(lockDir, oldDate, oldDate);
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [browserInstallerPath],
                options: {
                    env: {
                        ...process.env,
                        RALLAR_PLAYWRIGHT_INSTALL_SELF_TEST: 'lock-check',
                        RALLAR_PLAYWRIGHT_CACHE_DIR: cacheDir,
                        RALLAR_PLAYWRIGHT_LOCK_STALE_SECONDS: '1',
                        RALLAR_PLAYWRIGHT_LOCK_WAIT_SECONDS: '0',
                        RALLAR_PLAYWRIGHT_ACTIVE_INSTALLER_STALE_SECONDS: '600',
                        RALLAR_PLAYWRIGHT_TERMINATE_STALE_INSTALLER: 'false',
                        RALLAR_PLAYWRIGHT_PROCESS_LIST_FILE: processList
                    }
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('Stale Playwright installer detected for')
        });

        await expect(stat(lockDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    });

    it('runs the Playwright browser install from the checkout directory after switching users', async (context) => {
        const { directory: tmp, checkoutDirectory: checkoutDir, environment: installerEnvironment } = await createBrowserInstallerTools({
            label: 'rallar-playwright-install-cwd-',
            npmSource: [
                '#!/usr/bin/env bash',
                'printf "cwd=%s args=%s\\n" "$PWD" "$*" >> "${FAKE_NPM_CALLS_FILE}"',
                'if [[ "$*" == *"playwright --version"* ]]; then printf "Version 1.61.1\\n"; fi',
                ''
            ].join('\n'),
            runuserSource: [
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
                'printf "%s\\n" "$*" >> "${FAKE_RUNUSER_ARGS_FILE}"',
                'exec "$@"',
                ''
            ].join('\n')
        });
        const controllerDir = path.join(tmp, 'controller');
        const npmCallsFile = path.join(tmp, 'npm-calls.txt');
        const runuserCwdFile = path.join(tmp, 'runuser-cwd.txt');
        const runuserArgsFile = path.join(tmp, 'runuser-args.txt');
        await mkdir(controllerDir);
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                cwd: controllerDir,
                env: {
                    ...installerEnvironment,
                    FAKE_NPM_CALLS_FILE: npmCallsFile,
                    FAKE_RUNUSER_ARGS_FILE: runuserArgsFile,
                    FAKE_RUNUSER_CWD_FILE: runuserCwdFile,
                    RALLAR_PLAYWRIGHT_CACHE_DIR: path.join(tmp, 'ms-playwright')
                }
            }
        });

        await expect(readFile(runuserCwdFile, 'utf8')).resolves.toBe(`${checkoutDir}\n`);
        await expect(readFile(runuserArgsFile, 'utf8')).resolves.toContain(
            'playwright install chromium'
        );
        await expect(readFile(npmCallsFile, 'utf8')).resolves.toContain(`cwd=${checkoutDir}`);
        expect(stdout).toContain('selfTestInstall=ok');
    });

    it('skips apt when Playwright system dependencies are already installed', async (context) => {
        const { directory: tmp, environment: installerEnvironment } = await createBrowserInstallerTools({
            label: 'rallar-playwright-deps-present-',
            npmSource: [
                '#!/usr/bin/env bash',
                'printf "apt_config=%s args=%s\\n" "${APT_CONFIG:-}" "$*" >> "${FAKE_NPM_CALLS_FILE}"',
                'if [[ "$*" == *"playwright --version"* ]]; then printf "Version 1.61.1\\n"; fi',
                ''
            ].join('\n')
        });
        const browserRoot = path.join(tmp, 'browsers');
        const npmCallsFile = path.join(tmp, 'npm-calls.txt');
        await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                env: { ...installerEnvironment, FAKE_NPM_CALLS_FILE: npmCallsFile }
            }
        });

        const calls = await readFile(npmCallsFile, 'utf8');
        expect(calls).toContain('playwright install-deps --dry-run chromium');
        expect(calls).not.toMatch(/playwright install-deps chromium/);
        expect(calls).toContain('playwright install chromium');
        expect(await readlink(path.join(browserRoot, 'active'))).toContain('versions/1.61.1-chromium-');
    });

    it('isolates missing Playwright dependencies to official Ubuntu apt sources', async (context) => {
        const { directory: tmp, environment: installerEnvironment } = await createBrowserInstallerTools({
            label: 'rallar-playwright-ubuntu-apt-',
            npmSource: [
                '#!/usr/bin/env bash',
                'if [[ "$*" == *"playwright --version"* ]]; then printf "Version 1.61.1\\n"; exit 0; fi',
                'if [[ "$*" == *"install-deps --dry-run"* ]]; then',
                '  count=0',
                '  [[ -r "${FAKE_DRY_RUN_COUNT_FILE}" ]] && count="$(cat "${FAKE_DRY_RUN_COUNT_FILE}")"',
                '  count=$((count + 1))',
                '  printf "%s" "${count}" > "${FAKE_DRY_RUN_COUNT_FILE}"',
                '  [[ "${count}" -gt 1 ]]',
                '  exit',
                'fi',
                'if [[ "$*" == *"playwright install-deps chromium"* ]]; then',
                '  cat "${APT_CONFIG}" > "${FAKE_APT_CONFIG_EVIDENCE_FILE}"',
                'fi',
                'exit 0',
                ''
            ].join('\n')
        });
        const dryRunCountFile = path.join(tmp, 'dry-run-count.txt');
        const aptConfigEvidenceFile = path.join(tmp, 'apt-config.txt');
        const ubuntuSourcesFile = path.join(tmp, 'ubuntu.sources');
        await writeFile(ubuntuSourcesFile, 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n');
        await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                env: {
                    ...installerEnvironment,
                    FAKE_APT_CONFIG_EVIDENCE_FILE: aptConfigEvidenceFile,
                    FAKE_DRY_RUN_COUNT_FILE: dryRunCountFile,
                    RALLAR_APT_UBUNTU_SOURCES_FILE: ubuntuSourcesFile
                }
            }
        });

        const aptConfig = await readFile(aptConfigEvidenceFile, 'utf8');
        expect(aptConfig).toContain(`Dir::Etc::sourcelist "${ubuntuSourcesFile}";`);
        expect(aptConfig).toContain('Dir::Etc::sourceparts "-";');
        expect(aptConfig).toContain('Acquire::Retries "3";');
        expect(aptConfig).not.toContain('nodesource');
        expect(aptConfig).not.toContain('cloudsmith');
    });

    it('preserves the active Playwright browser when candidate installation fails', async (context) => {
        const { directory: tmp, environment: installerEnvironment } = await createBrowserInstallerTools({
            label: 'rallar-playwright-preserve-active-',
            npmSource: [
                '#!/usr/bin/env bash',
                'printf "browser_path=%s args=%s\\n" "${PLAYWRIGHT_BROWSERS_PATH:-}" "$*" >> "${FAKE_NPM_CALLS_FILE}"',
                'if [[ "$*" == *"playwright --version"* ]]; then printf "Version 1.61.1\\n"; exit 0; fi',
                'if [[ "$*" == *"install-deps --dry-run"* ]]; then exit 0; fi',
                'if [[ "$*" == *"playwright install chromium"* ]]; then exit 23; fi',
                'exit 0',
                ''
            ].join('\n')
        });
        const browserRoot = path.join(tmp, 'browsers');
        const oldBrowserDir = path.join(browserRoot, 'versions', '1.60.0-chromium-old');
        const npmCallsFile = path.join(tmp, 'npm-calls.txt');
        await mkdir(oldBrowserDir, { recursive: true });
        await symlink('versions/1.60.0-chromium-old', path.join(browserRoot, 'active'));
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [browserInstallerPath],
                options: {
                    env: { ...installerEnvironment, FAKE_NPM_CALLS_FILE: npmCallsFile }
                }
            })
        ).rejects.toMatchObject({ code: 23 });

        await expect(readlink(path.join(browserRoot, 'active'))).resolves.toBe(
            'versions/1.60.0-chromium-old'
        );
        await expect(stat(oldBrowserDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
        await expect(readFile(npmCallsFile, 'utf8')).resolves.toMatch(
            /browser_path=.*\.candidate-1\.61\.1-chromium-[a-f0-9]{12}\./
        );
    });

    it('skips the duplicate headless Playwright install after a successful rollout', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toMatch(
                /\.\/08-rollout-controller\.sh[\s\S]*RALLAR_INSTALL_PLAYWRIGHT=0[\s\S]*export RALLAR_INSTALL_PLAYWRIGHT[\s\S]*RALLAR_WRITE_HEADLESS_ENV=1 \.\/09-start-headless-workers\.sh/
            );
        }
    });
    it('replaces an invalid inactive browser version only after its candidate passes smoke', async (context) => {
        const { directory: tmp, environment: installerEnvironment } = await createBrowserInstallerTools({
            label: 'rallar-playwright-replace-invalid-',
            npmSource: [
                '#!/usr/bin/env bash',
                'if [[ "$*" == *"playwright --version"* ]]; then printf "Version 1.61.1\\n"; exit 0; fi',
                'if [[ "$*" == *"install-deps --dry-run"* ]]; then exit 0; fi',
                'if [[ "$*" == *"playwright install chromium"* ]]; then',
                '  printf "installed\\n" > "${PLAYWRIGHT_BROWSERS_PATH}/installed"',
                'fi',
                'exit 0',
                ''
            ].join('\n'),
            nodeSource: [
                '#!/usr/bin/env bash',
                'count=0',
                '[[ -r "${FAKE_SMOKE_COUNT_FILE}" ]] && count="$(cat "${FAKE_SMOKE_COUNT_FILE}")"',
                'count=$((count + 1))',
                'printf "%s" "${count}" > "${FAKE_SMOKE_COUNT_FILE}"',
                '[[ "${count}" -gt 1 ]]',
                ''
            ].join('\n')
        });
        const browserRoot = path.join(tmp, 'browsers');
        const oldBrowserDir = path.join(browserRoot, 'versions', '1.60.0-chromium-old');
        const packageLock = '{}';
        const packageLockHash = createHash('sha256').update(packageLock).digest('hex');
        const targetDir = path.join(
            browserRoot,
            'versions',
            `1.61.1-chromium-${packageLockHash.slice(0, 12)}`
        );
        const smokeCountFile = path.join(tmp, 'smoke-count.txt');
        await mkdir(oldBrowserDir, { recursive: true });
        await mkdir(targetDir, { recursive: true });
        await writeFile(path.join(targetDir, 'invalid'), 'invalid\n');
        await symlink('versions/1.60.0-chromium-old', path.join(browserRoot, 'active'));
        await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [browserInstallerPath],
            options: {
                env: { ...installerEnvironment, FAKE_SMOKE_COUNT_FILE: smokeCountFile }
            }
        });

        await expect(readFile(path.join(targetDir, 'installed'), 'utf8')).resolves.toBe('installed\n');
        await expect(stat(path.join(targetDir, 'invalid'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readlink(path.join(browserRoot, 'active'))).resolves.toBe(
            `versions/${path.basename(targetDir)}`
        );
    });
});
