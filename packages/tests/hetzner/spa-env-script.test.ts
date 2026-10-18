import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const rolloutScript = path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh');
const spaHelper = path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-public-spa-env.sh');
const execFileAsync = promisify(execFile);

async function createEnvironmentFixture(context: TestContext): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-env-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

async function runRolloutEnvironmentOperation(operation: string, envFile: string, environment: NodeJS.ProcessEnv = {}) {
    return await execFileAsync('bash', [rolloutScript], {
        cwd: repoRoot,
        env: {
            ...process.env,
            ...environment,
            RALLAR_ROLLOUT_SCRIPT_SELF_TEST: operation,
            RALLAR_API_ENV_FILE: envFile
        }
    });
}

describe('Hetzner SPA public env wiring', () => {
    it('passes the configured public SPA values to both builds and adds its origin to API and control CORS', async (context) => {
        const fixture = await createEnvironmentFixture(context);
        const runuser = path.join(fixture, 'runuser');
        const buildLog = path.join(fixture, 'build.log');
        await writeFile(runuser, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$BUILD_LOG"\n');
        await chmod(runuser, 0o755);

        const result = await execFileAsync('bash', [
            '-c',
            [
                `source '${spaHelper}'`,
                'apply_rallar_public_cors_defaults',
                'build_rallar_black_box_spa /fixture/checkout',
                'printf "%s\\n%s\\n" "$RALLAR_API_CORS_ORIGINS" "$RALLAR_BLACK_BOX_ALLOWED_ORIGINS"'
            ].join('\n')
        ], {
            env: {
                ...process.env,
                PATH: `${fixture}:${process.env.PATH}`,
                BUILD_LOG: buildLog,
                RALLAR_BLACK_BOX_SPA_URL: 'https://fixture.example.test/operator',
                RALLAR_API_BASE_URL: 'https://api.example.test',
                RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.example.test/control',
                RALLAR_BLACK_BOX_ROOM_ID: 'fixture-room',
                RALLAR_BLACK_BOX_AGENT_PREFIX: 'fixture-agent',
                RALLAR_BLACK_BOX_AGENT_COUNT: '3'
            }
        });

        const [apiOrigins, controlOrigins] = result.stdout.trim().split('\n');
        expect(apiOrigins).toContain('https://fixture.example.test');
        expect(controlOrigins).toContain('https://fixture.example.test');
        const builds = (await readFile(buildLog, 'utf8')).trim().split('\n');
        expect(builds).toHaveLength(2);
        for (const build of builds) {
            expect(build).toContain('VITE_RALLAR_PROVIDER=browser-rallar');
            expect(build).toContain('VITE_RALLAR_API_BASE_URL=https://api.example.test');
            expect(build).toContain('VITE_RALLAR_CONTROL_URL=wss://control.example.test/control');
            expect(build).toContain('VITE_RALLAR_ROOM_ID=fixture-room');
            expect(build).toContain('VITE_RALLAR_RUNNER_AGENT_PREFIX=fixture-agent');
            expect(build).toContain('VITE_RALLAR_RUNNER_AGENT_COUNT=3');
        }
        expect(builds[0]).toContain('--workspace rallar-black-box run build');
        expect(builds[1]).toContain('--workspace rallar-black-box-headless run build');
    });

    it('normalizes an existing API env file without logging secrets and keeps mode 0600', async (context) => {
        const fixture = await createEnvironmentFixture(context);
        const envFile = path.join(fixture, 'api-v1.env');
        const authSecret = 'auth-secret-that-must-not-be-logged';
        const databaseUrl = `postgres://rallar:${'d'.repeat(64)}@127.0.0.1:5432/rallar_api_v1`;
        await writeFile(
            envFile,
            [
                'ENVIRONMENT=production',
                'RALLAR_SQL_BACKEND=pglite-memory',
                'RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory',
                'RALLAR_ICE_MODE=metered',
                'UNKNOWN_SETTING=removed',
                `RALLAR_AUTH_CREDENTIAL_SECRET=${authSecret}`,
                `DATABASE_URL=${databaseUrl}`,
                'PORT=8080',
                ''
            ].join('\n')
        );

        const result = await runRolloutEnvironmentOperation('normalize-api-environment', envFile);
        expect(await readFile(envFile, 'utf8')).toBe([
            `RALLAR_AUTH_CREDENTIAL_SECRET=${authSecret}`,
            `DATABASE_URL=${databaseUrl}`,
            'PORT=8080',
            'RALLAR_API_CONFIGURATION_PROFILE=prod',
            'RALLAR_ICE_MODE=local',
            ''
        ].join('\n'));
        expect((await stat(envFile)).mode & 0o777).toBe(0o600);
        for (const secret of [authSecret, databaseUrl]) {
            expect(result.stdout).not.toContain(secret);
            expect(result.stderr).not.toContain(secret);
        }
    });

    it('retains controller per-IP auth limits while normalizing the API environment', async (context) => {
        const fixture = await createEnvironmentFixture(context);
        const envFile = path.join(fixture, 'api-v1.env');
        await writeFile(envFile, 'RALLAR_REGISTRATION_IP_RATE_LIMIT=200\nRALLAR_LOGIN_IP_RATE_LIMIT=200\n');

        await runRolloutEnvironmentOperation('normalize-api-environment', envFile);
        expect(await readFile(envFile, 'utf8')).toBe([
            'RALLAR_REGISTRATION_IP_RATE_LIMIT=200',
            'RALLAR_LOGIN_IP_RATE_LIMIT=200',
            'RALLAR_API_CONFIGURATION_PROFILE=prod',
            'RALLAR_ICE_MODE=local',
            ''
        ].join('\n'));
    });

    it('writes non-empty optional API overrides and removes them when rollout inputs are blank', async (context) => {
        const fixture = await createEnvironmentFixture(context);
        const envFile = path.join(fixture, 'api-v1.env');
        const optionalOverrides = {
            RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '7',
            RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '6',
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '24',
            RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '3'
        };
        await writeFile(envFile, 'PORT=8080\n');

        await runRolloutEnvironmentOperation('write-api-optional-environment', envFile, optionalOverrides);
        expect(await readFile(envFile, 'utf8')).toBe([
            'PORT=8080',
            ...Object.entries(optionalOverrides).map(([name, value]) => `${name}=${value}`),
            ''
        ].join('\n'));

        await runRolloutEnvironmentOperation(
            'write-api-optional-environment',
            envFile,
            Object.fromEntries(Object.keys(optionalOverrides).map((name) => [name, '']))
        );
        expect(await readFile(envFile, 'utf8')).toBe('PORT=8080\n');
        expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    });
});
