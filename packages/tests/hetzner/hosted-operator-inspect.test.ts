import { load } from 'js-yaml';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { runOwnedTestProcess } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const controllerDir = path.join(repoRoot, 'scripts/hosted-rallar/controller');

async function inspect(context: TestContext, overrides: Record<string, string> = {}) {
    const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-hosted-inspect-'));
    context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
    const bin = path.join(fixture, 'bin');
    await mkdir(bin);
    const commands = path.join(fixture, 'commands');
    const migrationChecksum = '0'.repeat(64);
    const stub = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$INSPECT_COMMANDS"
case "$(basename "$0")" in
  systemctl) if [[ "$1" == is-active ]]; then printf active; elif [[ "$1" == show ]]; then printf 123; fi ;;
  curl) printf 200 ;;
  git) if [[ "$*" == *rev-parse* ]]; then printf '%040d' 0; fi ;;
  runuser) printf '%s\\n' '{"databaseOid":1,"roleOid":2,"runtimeStateTableOid":3,"totalRows":5,"authUserRows":2,"groupRows":1,"migrations":[{"name":"20261018000000_fixture","checksum":"${migrationChecksum}","applied":true,"failed":false}],"secret":"never-print-db-secret"}' ;;
esac
`;
    for (const name of ['systemctl', 'curl', 'git', 'runuser', 'pgrep']) {
        await writeFile(path.join(bin, name), name === 'pgrep' ? '#!/usr/bin/env bash\nexit 1\n' : stub);
        await chmod(path.join(bin, name), 0o755);
    }
    const envFile = path.join(fixture, 'api.env');
    const secretFile = path.join(fixture, 'secret.env');
    const controlFile = path.join(fixture, 'control.env');
    const spaFile = path.join(fixture, 'spa.env');
    await writeFile(
        envFile,
        'RALLAR_TIMING_LOGS=0\nRALLAR_APP_INBOX_PHASE_TIMING=false\nRALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=3\nCORS_ORIGINS=https://spa.example.test\nDATABASE_URL=never-print-this\n'
    );
    await writeFile(secretFile, 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=4\nRALLAR_AUTH_CREDENTIAL_SECRET=never-print-secret\n');
    await writeFile(controlFile, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://spa.example.test\nRALLAR_BLACK_BOX_ADMIN_TOKEN=never-print-control-secret\n');
    await writeFile(
        spaFile,
        [
            'RALLAR_BLACK_BOX_SPA_URL=https://spa.example.test',
            'RALLAR_BLACK_BOX_CONTROL_URL=wss://control.example.test/control',
            'RALLAR_API_BASE_URL=https://api.example.test',
            'RALLAR_API_CORS_ORIGINS=https://spa.example.test',
            'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://spa.example.test',
            'RALLAR_BLACK_BOX_ROOM_ID=prior-room',
            'RALLAR_BLACK_BOX_AGENT_PREFIX=prior-agent',
            'RALLAR_BLACK_BOX_AGENT_COUNT=2',
            'VITE_RALLAR_API_BASE_URL=https://api.example.test',
            'VITE_RALLAR_CONTROL_URL=wss://control.example.test/control',
            'VITE_RALLAR_ROOM_ID=prior-room',
            'VITE_RALLAR_APPLICATION_ID=prior-app',
            'VITE_RALLAR_WORKSPACE_ID=prior-workspace',
            'VITE_RALLAR_RUNNER_AGENT_PREFIX=prior-agent',
            'VITE_RALLAR_RUNNER_AGENT_COUNT=2',
            'UNRELATED_SECRET=never-print-spa-secret',
            ''
        ].join('\n')
    );
    await mkdir(path.join(fixture, '.git'));
    await mkdir(path.join(fixture, 'apps/api-v1/prisma/migrations/20261018000000_fixture'), { recursive: true });
    await writeFile(path.join(fixture, 'apps/api-v1/prisma/migrations/20261018000000_fixture/migration.sql'), 'SELECT 1;\n');
    await writeFile(path.join(fixture, 'apps/api-v1/prisma/schema.prisma'), 'datasource db {}\n');
    await writeFile(path.join(fixture, 'package-lock.json'), '{}\n');
    await writeFile(
        path.join(fixture, 'readiness.json'),
        JSON.stringify({
            deployedCommit: '0'.repeat(40),
            apiHealthStatus: 'passed',
            controlHealthStatus: 'passed',
            publicHealthStatus: 'passed'
        })
    );
    const stream = `${await readFile(path.join(controllerDir, 'rallar-api-effective-env.sh'), 'utf8')}\n${await readFile(
        path.join(controllerDir, '07-status-controller.sh'),
        'utf8'
    )}`;
    const script = path.join(fixture, 'stream.sh');
    await writeFile(script, stream);
    const environment = {
        PATH: `${bin}:${process.env.PATH}`,
        LANG: 'C',
        LC_ALL: 'C',
        INSPECT_COMMANDS: commands,
        RALLAR_API_ENV_FILE: envFile,
        RALLAR_API_SECRET_FILE: secretFile,
        RALLAR_CONTROL_ENV_FILE: controlFile,
        RALLAR_BLACK_BOX_SPA_ENV_FILE: spaFile,
        RALLAR_CHECKOUT_DIR: fixture,
        RALLAR_DEPLOYMENT_READINESS_PATH: path.join(fixture, 'readiness.json'),
        RALLAR_API_STORE_FAILURE_FILE: path.join(fixture, 'failure'),
        ...overrides
    };
    const run = () =>
        runOwnedTestProcess(context, {
            executable: 'bash',
            args: [script, '--inspect'],
            options: { env: environment }
        });
    return { fixture, bin, envFile, secretFile, controlFile, spaFile, commands, environment, run };
}

describe('hosted operator inspect', () => {
    it('streams allowlisted evidence with secret-file precedence and no mutation', async (context) => {
        const fixture = await inspect(context);
        await writeFile(
            path.join(fixture.fixture, 'readiness.json'),
            JSON.stringify({
                deployedCommit: '0'.repeat(40),
                apiHealthStatus: 'passed',
                controlHealthStatus: 'passed',
                publicHealthStatus: 'passed',
                secret: 'never-print-readiness-secret'
            })
        );
        const { stdout, stderr } = await fixture.run();
        expect(stderr).toBe('');
        const evidence = JSON.parse(stdout);
        expect(evidence.configuration.RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT).toEqual({ present: true, value: '4', source: 'secret' });
        expect(evidence.configuration.RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE).toEqual({ present: false, value: null, source: null });
        expect(evidence.configuration.RALLAR_TIMING_LOGS).toEqual({ present: true, value: '0', source: 'environment' });
        expect(evidence.operatorSettings.RALLAR_BLACK_BOX_SPA_URL).toEqual({ present: true, value: 'https://spa.example.test', source: 'spa-environment' });
        expect(evidence.operatorSettings.RALLAR_BLACK_BOX_AGENT_COUNT).toEqual({ present: true, value: '2', source: 'spa-environment' });
        expect(evidence.operatorSettings.VITE_RALLAR_APPLICATION_ID).toEqual({ present: true, value: 'prior-app', source: 'spa-environment' });
        expect(Object.keys(evidence.operatorSettings)).toHaveLength(10);
        expect(evidence.processes).toEqual({ api: true, control: true, headless: true });
        expect(evidence.database).toEqual({
            databaseOid: 1,
            roleOid: 2,
            runtimeStateTableOid: 3,
            totalRows: 5,
            authUserRows: 2,
            groupRows: 1,
            migrations: [{ name: '20261018000000_fixture', checksum: '0'.repeat(64), applied: true, failed: false }]
        });
        expect(evidence.sourceMigrations).toEqual([{
            name: '20261018000000_fixture',
            checksum: expect.stringMatching(/^[0-9a-f]{64}$/u)
        }]);
        expect(stdout).not.toMatch(/never-print|PASSWORD|journal|DATABASE_URL|username/iu);
        const commands = await readFile(fixture.commands, 'utf8');
        expect(commands).toContain('git --no-optional-locks');
        expect(commands).toContain(
            'curl --silent --show-error --output /dev/null --write-out %{http_code} --max-time 10 --header x-forwarded-proto: https http://127.0.0.1:5180/health'
        );
        expect(commands).toContain('https://api.example.test/api/config');
        expect(commands).toContain('https://control.example.test/health');
        expect(commands).not.toMatch(/systemctl (start|stop|restart|reload|enable|disable|status)\b/u);
        await writeFile(fixture.envFile, 'RALLAR_TIMING_LOGS=1\nCORS_ORIGINS=https://spa.example.test\n');
        const mixed = JSON.parse((await fixture.run()).stdout);
        expect(mixed.configuration.RALLAR_TIMING_LOGS).toEqual({ present: true, value: '1', source: 'environment' });
        expect(mixed.configuration.RALLAR_APP_INBOX_PHASE_TIMING).toEqual({ present: false, value: null, source: null });
    });

    it('fails closed on unsupported effective assignment', async (context) => {
        const fixture = await inspect(context);
        await writeFile(fixture.secretFile, 'export RALLAR_TIMING_LOGS=1\n');
        await expect(fixture.run()).rejects.toMatchObject({ stderr: expect.stringContaining('Unsupported assignment') });
    });

    it('fails without printing partial evidence when readiness is missing', async (context) => {
        const fixture = await inspect(context);
        await rm(path.join(fixture.fixture, 'readiness.json'));
        await expect(fixture.run()).rejects.toMatchObject({
            stderr: expect.stringContaining('required nonsecret evidence: readiness'),
            stdout: ''
        });
    });

    it('fails closed when required database evidence cannot be read', async (context) => {
        const fixture = await inspect(context);
        await writeFile(
            path.join(fixture.fixture, 'readiness.json'),
            JSON.stringify({
                deployedCommit: '0'.repeat(40),
                apiHealthStatus: 'passed',
                controlHealthStatus: 'passed',
                publicHealthStatus: 'passed'
            })
        );
        await writeFile(path.join(fixture.bin, 'runuser'), '#!/usr/bin/env bash\nexit 8\n');
        await expect(fixture.run()).rejects.toMatchObject({
            stderr: expect.stringContaining('required nonsecret evidence: database'),
            stdout: ''
        });
    });

    it('fails without output when persisted public settings disagree with live API or control configuration', async (context) => {
        const fixture = await inspect(context);
        await writeFile(fixture.envFile, 'RALLAR_TIMING_LOGS=0\nRALLAR_APP_INBOX_PHASE_TIMING=false\nCORS_ORIGINS=https://different.example.test\n');
        await expect(fixture.run()).rejects.toMatchObject({ stderr: expect.stringContaining('public settings'), stdout: '' });
        await writeFile(fixture.envFile, 'RALLAR_TIMING_LOGS=0\nRALLAR_APP_INBOX_PHASE_TIMING=false\nCORS_ORIGINS=https://spa.example.test\n');
        await writeFile(fixture.controlFile, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://different.example.test\n');
        await expect(fixture.run()).rejects.toMatchObject({ stderr: expect.stringContaining('public settings'), stdout: '' });
        await writeFile(fixture.controlFile, 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://spa.example.test\n');
        const spa = await readFile(fixture.spaFile, 'utf8');
        await writeFile(
            fixture.spaFile,
            spa.replace('VITE_RALLAR_CONTROL_URL=wss://control.example.test/control', 'VITE_RALLAR_CONTROL_URL=wss://different.example.test/control')
        );
        await expect(fixture.run()).rejects.toMatchObject({ stderr: expect.stringContaining('public settings mirror'), stdout: '' });
    });

    it('fails before printing a URL with a query or a missing required public setting', async (context) => {
        const fixture = await inspect(context);
        const original = await readFile(fixture.spaFile, 'utf8');
        await writeFile(fixture.spaFile, original.replace('https://spa.example.test', 'https://spa.example.test?token=secret'));
        await expect(fixture.run()).rejects.toMatchObject({ stderr: expect.stringContaining('public settings'), stdout: '' });
        await writeFile(fixture.spaFile, original.replace('RALLAR_BLACK_BOX_AGENT_COUNT=2\n', ''));
        await expect(fixture.run()).rejects.toMatchObject({ stderr: expect.stringContaining('public settings'), stdout: '' });
    });
});

describe('hosted controller workflow restoration', () => {
    it('refuses requested timing/topology writes hidden by a systemd secret-file override', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-topology-override-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const envFile = path.join(fixture, 'api.env');
        const secretFile = path.join(fixture, 'secret.env');
        await writeFile(envFile, 'RALLAR_TIMING_LOGS=0\nRALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=3\n');
        await writeFile(secretFile, 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=4\n');
        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: [path.join(controllerDir, '08-rollout-controller.sh')],
            options: {
                env: {
                    PATH: process.env.PATH,
                    RALLAR_API_ENV_FILE: envFile,
                    RALLAR_API_SECRET_FILE: secretFile,
                    RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '3',
                    RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'preflight-api-overrides'
                }
            }
        })).rejects.toMatchObject({ stderr: expect.stringContaining('Secret-file override') });
        expect(await readFile(envFile, 'utf8')).toBe('RALLAR_TIMING_LOGS=0\nRALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=3\n');
        await writeFile(secretFile, 'RALLAR_TIMING_LOGS=0\n');
        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: [path.join(controllerDir, '08-rollout-controller.sh')],
            options: {
                env: {
                    PATH: process.env.PATH,
                    RALLAR_API_ENV_FILE: envFile,
                    RALLAR_API_SECRET_FILE: secretFile,
                    RALLAR_API_SERVER_TIMING: 'true',
                    RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'preflight-api-overrides'
                }
            }
        })).rejects.toMatchObject({ stderr: expect.stringContaining('Secret-file override for RALLAR_TIMING_LOGS') });
    });
    it('isolates inspect from every remote write step and executes its streamed probe', async (context) => {
        const workflow = load(await readFile(path.join(repoRoot, '.github/workflows/deploy-hetzner-controller.yml'), 'utf8')) as {
            jobs: { deploy: { steps: { name: string; if?: string; run?: string; }[]; }; };
        };
        const steps = workflow.jobs.deploy.steps;
        const inspectStep = steps.find((step) => step.name === 'Inspect reviewed source on controller');
        expect(inspectStep?.if).toBe('inputs.action == \'inspect\'');
        expect(steps.findIndex((step) => step.name === 'Configure SSH')).toBeLessThan(steps.indexOf(inspectStep!));
        expect(inspectStep?.run).toContain('cat scripts/hosted-rallar/controller/rallar-api-effective-env.sh');
        expect(inspectStep?.run).toContain('\'bash -s -- --inspect\'');
        for (const name of ['Copy controller scripts', 'Sync optional Metered TURN secrets', 'Run controlled rollout']) {
            expect(steps.find((step) => step.name === name)?.if).toBe('inputs.action == \'rollout\'');
        }
        const fixture = await inspect(context);
        await writeFile(
            path.join(fixture.fixture, 'readiness.json'),
            JSON.stringify({
                deployedCommit: '0'.repeat(40),
                apiHealthStatus: 'passed',
                controlHealthStatus: 'passed',
                publicHealthStatus: 'passed'
            })
        );
        await writeFile(path.join(fixture.bin, 'ssh'), '#!/usr/bin/env bash\nbash -s -- --inspect\n');
        await chmod(path.join(fixture.bin, 'ssh'), 0o755);
        const script = path.join(fixture.fixture, 'workflow-inspect.sh');
        const summary = path.join(fixture.fixture, 'summary.md');
        await writeFile(script, inspectStep!.run!);
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [script],
            options: {
                cwd: repoRoot,
                env: { ...fixture.environment, RALLAR_REPO_REF: '0'.repeat(40), HETZNER_HOST: 'fixture', HETZNER_USER: 'fixture', GITHUB_STEP_SUMMARY: summary }
            }
        });
        expect(JSON.parse(stdout).deployedCommit).toBe('0'.repeat(40));
        expect(await readFile(summary, 'utf8')).toContain('Reviewed inspect source');
        expect(await readFile(fixture.commands, 'utf8')).not.toMatch(/systemctl (start|stop|restart|reload|enable|disable|status)\b/u);
    });

    it('transmits omitted topology by default and exact absent/set values for restoration', async (context) => {
        const workflow = load(await readFile(path.join(repoRoot, '.github/workflows/deploy-hetzner-controller.yml'), 'utf8')) as {
            jobs: { deploy: { steps: { name: string; run?: string; }[]; }; };
        };
        const run = workflow.jobs.deploy.steps.find((step) => step.name === 'Run controlled rollout')?.run;
        expect(run).toBeDefined();
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-workflow-rollout-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const script = path.join(fixture, 'rollout.sh');
        const bin = path.join(fixture, 'bin');
        await mkdir(bin);
        await writeFile(script, run!);
        await writeFile(path.join(bin, 'scp'), '#!/usr/bin/env bash\ncp "$3" "$CAPTURED_ROLLOUT_ENV"\n');
        await writeFile(path.join(bin, 'ssh'), '#!/usr/bin/env bash\ncat >/dev/null\n');
        await chmod(path.join(bin, 'scp'), 0o755);
        await chmod(path.join(bin, 'ssh'), 0o755);
        const capturedEnv = path.join(fixture, 'captured.env');
        const { stdout: commitOutput } = await runOwnedTestProcess(context, {
            executable: 'git',
            args: ['rev-parse', 'HEAD'],
            options: { cwd: repoRoot }
        });
        const baseEnvironment = {
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: fixture,
            CAPTURED_ROLLOUT_ENV: capturedEnv,
            HETZNER_HOST: 'fixture',
            HETZNER_USER: 'fixture',
            RALLAR_REPO_REF: commitOutput.trim(),
            RALLAR_INCLUDE_CADDY: 'false',
            RALLAR_INSTALL_PLAYWRIGHT: 'false',
            RALLAR_SERVER_TIMING: 'false',
            RALLAR_BLACK_BOX_SPA_URL: 'https://example.test',
            RALLAR_BLACK_BOX_CONTROL_URL: 'wss://example.test/control',
            RALLAR_API_BASE_URL: 'https://example.test',
            RALLAR_API_CORS_ORIGINS: '',
            RALLAR_BLACK_BOX_ALLOWED_ORIGINS: '',
            RALLAR_BLACK_BOX_ROOM_ID: 'test',
            RALLAR_BLACK_BOX_AGENT_PREFIX: 'test',
            RALLAR_BLACK_BOX_AGENT_COUNT: '1',
            RALLAR_BLACK_BOX_APPLICATION_ID: 'test',
            RALLAR_BLACK_BOX_WORKSPACE_ID: 'test',
            RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT_INPUT: '',
            RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE_INPUT: '',
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE_INPUT: '',
            RALLAR_RTC_TOPOLOGY_MESH_PARAM_K_INPUT: ''
        };
        async function execute(applyTopology: string, values: Record<string, string> = {}) {
            await runOwnedTestProcess(context, {
                executable: 'bash',
                args: [script],
                options: {
                    cwd: repoRoot,
                    env: { ...baseEnvironment, RALLAR_APPLY_TOPOLOGY: applyTopology, ...values }
                }
            });
            return await readFile(capturedEnv, 'utf8');
        }
        const normal = await execute('false', { RALLAR_REPO_REF: 'main' });
        expect(normal).toContain('RALLAR_API_SERVER_TIMING=0');
        expect(normal).not.toContain('RALLAR_RTC_TOPOLOGY_');
        const timed = await execute('false', { RALLAR_SERVER_TIMING: 'true' });
        expect(timed).toContain('RALLAR_API_SERVER_TIMING=1');
        expect(timed).not.toContain('RALLAR_RTC_TOPOLOGY_');
        const restored = await execute('true', {
            RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT_INPUT: '3',
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE_INPUT: '51'
        });
        expect(restored).toContain('RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=3\n');
        expect(restored).toContain('RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE=\'\'\n');
        expect(restored).toContain('RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=51\n');
        expect(restored).toContain('RALLAR_RTC_TOPOLOGY_MESH_PARAM_K=\'\'\n');
        await expect(execute('true', { RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE_INPUT: '0' }))
            .rejects.toMatchObject({ stderr: expect.stringContaining('positive integers') });
        await expect(execute('true', { RALLAR_REPO_REF: 'main' }))
            .rejects.toMatchObject({ stderr: expect.stringContaining('reviewed full source commit') });
    });

    it('preserves topology by default and applies absent/set restoration through the actual writer', async (context) => {
        const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-topology-restore-'));
        context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
        const envFile = path.join(fixture, 'api.env');
        const original = 'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=3\nRALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE=51\n';
        await writeFile(envFile, original);
        async function writeTopology(values: Record<string, string>) {
            await runOwnedTestProcess(context, {
                executable: 'bash',
                args: [path.join(controllerDir, '08-rollout-controller.sh')],
                options: {
                    env: { PATH: process.env.PATH, RALLAR_API_ENV_FILE: envFile, RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'write-api-optional-environment', ...values }
                }
            });
            return await readFile(envFile, 'utf8');
        }
        expect(await writeTopology({})).toBe(original);
        expect(
            await writeTopology({
                RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '',
                RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '7',
                RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '',
                RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '2'
            })
        ).toBe(
            'RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE=7\nRALLAR_RTC_TOPOLOGY_MESH_PARAM_K=2\n'
        );
    });
});
