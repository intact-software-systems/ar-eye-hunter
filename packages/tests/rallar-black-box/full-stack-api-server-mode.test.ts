import {
    execFileSync,
    spawnSync,
    type SpawnSyncReturns
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    mkdir,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { readApiV1Configuration } from '../../../apps/api-v1/src/configuration/read-api-v1-configuration.ts';
import {
    assertFullStackApiConfigEvidence,
    assertFullStackControlHealthEvidence,
    assertFullStackReadinessHttpEvidence,
    createDefaultFullStackApiV1WebServer,
    createFullStackApiProfileEnvBlock,
    evaluateFullStackConfiguredServiceEvidence,
    readFullStackApiBaseUrl,
    readFullStackApiServerMode,
    readFullStackSpaBaseUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import { loadLiveRtcPerformanceAttempt } from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';
import type { ApiJsonObject } from '../../shared/api/api-json-value.ts';

const CONFIG_LOADER_TEST_TIMEOUT_MS = 30_000;
const LARGEST_CO_LOCATED_ALM_COHORT = 50;
const captureProbeEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    TSX_TSCONFIG_PATH: resolve('packages/tests/tsconfig.json'),
    RALLAR_BLACK_BOX_FULL_STACK: '1',
    RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '1',
    RALLAR_BLACK_BOX_API_MODE: 'memory',
    RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING: 'false',
    RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS: 'false',
    RALLAR_BLACK_BOX_STORAGE_DIR: '/tmp/rallar-capture-selection-recorder',
    RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER: '0'
};

const predeclaredEnvironmentObservation = {
    git: { headCommit: 'a'.repeat(40), headTree: 'b'.repeat(40), ref: 'codex/unit-fixture', clean: true },
    runtime: { node: 'v24.0.0', npm: '11.0.0', deno: '2.4.0', playwright: '1.55.0', chromium: '140.0.0.0' },
    host: {
        os: 'darwin',
        kernel: '24.0.0',
        architecture: 'arm64',
        logicalCpuCount: 12,
        cpuModel: 'unit-fixture',
        totalMemoryBytes: 24 * 1024 * 1024 * 1024,
        executionContext: 'local'
    },
    timing: {
        startedAtUtc: '2026-10-09T20:45:00.000Z',
        endedAtUtc: '2026-10-09T20:46:00.000Z',
        monotonicDurationMs: 60_000,
        monotonicSource: 'performance.now'
    },
    deviations: [],
    sourceHashes: [{
        path: 'tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts',
        sha256: 'c'.repeat(64),
        kind: 'source'
    }],
    configurationInputs: [],
    resolvedConfiguration: [],
    controllerInputs: [],
    workerCommand: {
        redactedArgv: { executable: 'npm', arguments: ['run', 'test:rallar:full-stack:memory:live-rtc-3'] },
        projection: { fixedWorkerFlags: [], configurationFlags: [] }
    },
    allowlistedEnvironment: {}
};

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('rallar-black-box full-stack API server mode', () => {
    it.each([
        { setup: 'false', ws: 'false', wrapper: false, direct: true, timingLogs: null, appInboxPhaseTiming: null, gracefulShutdown: null },
        { setup: 'true', ws: 'false', wrapper: true, direct: false, timingLogs: true, appInboxPhaseTiming: true, gracefulShutdown: 'SIGTERM' },
        { setup: 'false', ws: 'true', wrapper: true, direct: false, timingLogs: true, appInboxPhaseTiming: false, gracefulShutdown: 'SIGTERM' },
        { setup: 'true', ws: 'true', wrapper: true, direct: false, timingLogs: true, appInboxPhaseTiming: true, gracefulShutdown: 'SIGTERM' }
    ])(
        'capture selection normalizes setup=$setup and WS=$ws at the real config/command boundary',
        function assertSelectedFullStackApiCapture ({ setup, ws, ...expected }) {
            const result = startFullStackApiCaptureConfigProbe('full-stack', {
                RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING: setup,
                RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS: ws
            });
            expect(result.status, 'The selected config must produce its owned API command.').toBe(0);
            const observation: unknown = JSON.parse(result.stdout);
            expect(observation).toEqual({ ...expected, reuseExistingServer: false });
        }
    );

    it.each([
        { selectedPhase: undefined, expectedPhase: true },
        { selectedPhase: true, expectedPhase: true },
        { selectedPhase: false, expectedPhase: false }
    ])('capture selection preserves or selects phase=$expectedPhase at the current command owner', ({ selectedPhase, expectedPhase }) => {
        const captureRequest = {
            mode: 'memory' as const,
            timingCaptureDirectory: '/tmp/rallar-capture-selection-recorder',
            appInboxPhaseTiming: selectedPhase,
            environment: {}
        };
        const server = createDefaultFullStackApiV1WebServer(captureRequest);
        expect(server.command.includes(`RALLAR_APP_INBOX_PHASE_TIMING=${String(expectedPhase)}`)).toBe(true);
        expect(server.command.includes('RALLAR_TIMING_LOGS=true')).toBe(true);
        expect(server.command.includes('run-full-stack-api-with-timing.ts')).toBe(true);
        expect(server.reuseExistingServer).toBe(false);
        expect(server.gracefulShutdown).toEqual({ signal: 'SIGTERM', timeout: 7_000 });
    });

    it.each([
        { RALLAR_BLACK_BOX_FULL_STACK: '0' },
        { RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '0' },
        { RALLAR_BLACK_BOX_API_MODE: 'postgres' },
        { RALLAR_BLACK_BOX_STORAGE_DIR: '' },
        { RALLAR_BLACK_BOX_STORAGE_DIR: 'relative/recorder' }
    ])('capture selection rejects either opt-in outside its local memory/headless/absolute lifecycle: %j', (override) => {
        for (const flag of ['RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING', 'RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS']) {
            const result = startFullStackApiCaptureConfigProbe('full-stack', { [flag]: 'true', ...override });
            expect(result.status, `${flag} must refuse the incompatible lifecycle before command use.`).toBe(1);
            expect(result.stderr).toContain('Setup timing capture requires');
        }
    });

    it.each(['worker-capture', 'exhaustive'] as const)(
        'capture selection leaves the independent %s consumer on direct execution',
        function assertIndependentCaptureConsumer (configName) {
            const result = startFullStackApiCaptureConfigProbe(configName, {
                RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING: 'true',
                RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS: 'true'
            });
            expect(result.status, 'The independent consumer config must remain loadable.').toBe(0);
            const observation: unknown = JSON.parse(result.stdout);
            expect(observation).toEqual({
                wrapper: false,
                direct: true,
                timingLogs: null,
                appInboxPhaseTiming: null,
                reuseExistingServer: false,
                gracefulShutdown: null
            });
        }
    );

    it('preserves the ordinary exhaustive consumer with no diagnostic capture', function assertOrdinaryExhaustiveApiCommand () {
        const result = spawnSync(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            `import config from './apps/rallar-black-box/playwright.exhaustive.config.ts';
             const api = config.webServer[0];
             process.stdout.write(JSON.stringify({
                 retainsLoginOverride: api.command.includes('RALLAR_LOGIN_USER_RATE_LIMIT=123 CORS_ORIGINS='),
                 postgresInvocation: api.command.includes('deno run --env-file=apps/api-v1/.env.local'),
                 wrapper: api.command.includes('run-full-stack-api-with-timing'),
                 url: api.url, reuseExistingServer: api.reuseExistingServer, timeout: api.timeout,
                 gracefulShutdown: api.gracefulShutdown?.signal ?? null
             }));`
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                CI: '1',
                RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING: 'true',
                VITE_RALLAR_API_BASE_URL: 'http://localhost:8080',
                RALLAR_LOGIN_USER_RATE_LIMIT: '123'
            }
        });
        expect(result.status).toBe(0);
        const observed: unknown = JSON.parse(result.stdout);
        expect(observed).toEqual({
            retainsLoginOverride: true,
            postgresInvocation: true,
            wrapper: false,
            url: 'http://localhost:8080/api/config',
            reuseExistingServer: false,
            timeout: 90_000,
            gracefulShutdown: null
        });
    });

    it.each([
        { headless: '1', workspace: 'rallar-black-box-headless', readiness: '/headless/' },
        { headless: '', workspace: 'rallar-black-box', readiness: '' }
    ])(
        'selects $workspace at the configured SPA port with fresh CI ownership',
        function assertSelectedFullStackSpaCommand ({ headless, workspace, readiness }) {
            const result = spawnSync(process.execPath, [
                '--import',
                'tsx',
                '--input-type=module',
                '--eval',
                `import config from './apps/rallar-black-box/playwright.full-stack.config.ts';
             const spa = config.webServer[1];
             process.stdout.write(JSON.stringify({
                 serverCount: config.webServer.length,
                 selectedWorkspaceAndPort: spa.command === 'cd ../.. && npm --workspace ${workspace} run dev -- --port 5376 --force',
                 url: spa.url, reuseExistingServer: spa.reuseExistingServer,
                 allFresh: config.webServer.every(server => !server.reuseExistingServer)
             }));`
            ], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    CI: '1',
                    RALLAR_BLACK_BOX_FULL_STACK: '1',
                    RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: headless,
                    RALLAR_BLACK_BOX_API_MODE: 'memory',
                    VITE_RALLAR_SPA_BASE_URL: 'http://127.0.0.1:5376',
                    RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER: '0'
                }
            });
            expect(result.status).toBe(0);
            const observed: unknown = JSON.parse(result.stdout);
            expect(observed).toEqual({
                serverCount: 3,
                selectedWorkspaceAndPort: true,
                url: `http://127.0.0.1:5376${readiness}`,
                reuseExistingServer: false,
                allFresh: true
            });
        }
    );

    it('defaults to the existing Postgres-backed full-stack API server mode', () => {
        expect(readFullStackApiServerMode({})).toBe('postgres');
        expect(readFullStackApiBaseUrl({})).toBe('http://localhost:8080');
        expect(readFullStackSpaBaseUrl({})).toBe('http://localhost:5176');

        const server = createDefaultFullStackApiV1WebServer({
            mode: 'postgres',
            apiBaseUrl: 'http://localhost:8080/',
            spaBaseUrl: 'http://localhost:5178/'
        });

        expect(server.url).toBe('http://localhost:8080/api/config');
        expect(server.command).toContain('CORS_ORIGINS=http://localhost:5178,http://127.0.0.1:5178');
        expect(server.command).toContain('--env-file=apps/api-v1/.env.local');
        expect(server.command).toContain('RALLAR_API_BASE_URL=http://localhost:8080');
        expect(server.command).toContain('RALLAR_WS_BASE_URL=ws://localhost:8080');
        expect(server.command).toContain('RALLAR_SQL_BACKEND=postgres');
        expect(server.command).toContain('RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory');
        expect(server.command).toContain('RALLAR_PGLITE_SCHEMA_INIT=disabled');
        expect(server.command).toContain('RALLAR_DB_PUBSUB=postgres');
        expect(server.command).not.toContain('RALLAR_SQL_BACKEND=pglite-memory');
    });

    it('builds an API-v1 memory-mode full-stack server command with no DATABASE_URL requirement', () => {
        const server = createDefaultFullStackApiV1WebServer({
            mode: 'memory',
            apiBaseUrl: 'http://localhost:18080',
            spaBaseUrl: 'http://localhost:5177'
        });

        expect(server.url).toBe('http://localhost:18080/api/config');
        expect(server.command).toContain('CORS_ORIGINS=http://localhost:5177,http://127.0.0.1:5177');
        expect(server.command).toContain('PORT=18080');
        expect(server.command).toContain('RALLAR_API_BASE_URL=http://localhost:18080');
        expect(server.command).toContain('RALLAR_WS_BASE_URL=ws://localhost:18080');
        expect(server.command).toContain('RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory');
        expect(server.command).not.toContain('RALLAR_SQL_BACKEND=');
        expect(server.command).not.toContain('RALLAR_PGLITE_SCHEMA_INIT=');
        expect(server.command).not.toContain('RALLAR_DB_PUBSUB=');
        expect(server.command).not.toContain('RALLAR_ICE_MODE=');
        expect(server.command).toContain('RALLAR_LOGIN_USER_RATE_LIMIT=100');
        expect(server.command).toContain(
            'RALLAR_AUTH_CREDENTIAL_SECRET=local-rallar-full-stack-auth-credential-secret-v1'
        );
        expect(server.command).toContain(
            'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=local-rallar-full-stack-operator-secret-v1'
        );
        expect(server.command).not.toContain('DATABASE_URL');
        expect(server.command).not.toContain('--env-file=');
    });

    it('admits the largest co-located ALM cohort through one IP per registration and login window', async () => {
        const profileEnvironment = new Map(
            createFullStackApiProfileEnvBlock().split(' ').map((entry) => {
                const separator = entry.indexOf('=');
                return [entry.slice(0, separator), entry.slice(separator + 1)];
            })
        );
        const resource = (name: string) => new URL(`../../../apps/api-v1/resources/${name}`, import.meta.url);

        const configuration = await readApiV1Configuration({
            environment: { get: (name) => profileEnvironment.get(name) },
            hardwareConcurrency: 4,
            readTextFile: (url) => readFile(url, 'utf8'),
            defaultsUrl: resource('configuration/defaults-config.json'),
            profileUrls: {
                dev: resource('configuration/dev-config.json'),
                prod: resource('configuration/prod-config.json'),
                'prod-in-memory': resource('configuration/prod-in-memory-config.json'),
                'prod-hardened': resource('configuration/prod-hardened-config.json')
            },
            staticClientsUrl: resource('authorised-clients.json')
        });

        const { rateLimits } = configuration.authentication;
        expect(configuration.profile.name).toBe('prod-in-memory');
        expect(rateLimits.windowMs).toBe(60_000);
        expect(rateLimits.registrationIp).toBeGreaterThanOrEqual(LARGEST_CO_LOCATED_ALM_COHORT);
        expect(rateLimits.loginIp).toBeGreaterThanOrEqual(LARGEST_CO_LOCATED_ALM_COHORT);
        expect(rateLimits.loginUsername).toBe(100);
    });

    it.each([
        [{ RALLAR_BLACK_BOX_RTC_CASE_ID: 'default' }, 20],
        [{ RALLAR_BLACK_BOX_RTC_CASE_ID: 'all-scenarios', RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1' }, 20],
        [{
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            RALLAR_ICE_RATE_LIMIT_REQUESTS: '101'
        }, 101],
        [{ RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1', RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1', RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100' }, 106],
        [{ RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1', RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100' }, 103]
    ])(
        'passes the exact finite workload policy to the owned child and prevents reuse: %j',
        async (environment: Readonly<Record<string, string | undefined>>, expectedRequests: number) => {
            const selectedEnvironment = environment.RALLAR_BLACK_BOX_RTC_CASE_ID
                ? { ...await createPredeclaredSelection(environment.RALLAR_BLACK_BOX_RTC_CASE_ID), ...environment }
                : environment;
            const admittedAttempt = await loadLiveRtcPerformanceAttempt({ repoRoot: process.cwd(), environment: selectedEnvironment });
            const server = createDefaultFullStackApiV1WebServer({
                mode: 'memory',
                apiBaseUrl: 'http://localhost:18080',
                spaBaseUrl: 'http://localhost:5177',
                reuseExistingServer: true,
                environment: selectedEnvironment,
                admittedRtcCaseId: admittedAttempt?.locator.caseId ?? null
            });
            const commandPrefix = server.command.slice(0, server.command.indexOf('deno run'));
            const configurationProbe = `
            import { readApiV1Configuration } from "./apps/api-v1/src/configuration/read-api-v1-configuration.ts";
            const resource = name => new URL("./apps/api-v1/resources/configuration/" + name + "-config.json", import.meta.url);
            const configuration = await readApiV1Configuration({
                environment: { get: name => Deno.env.get(name) },
                hardwareConcurrency: navigator.hardwareConcurrency,
                readTextFile: url => Deno.readTextFile(url),
                defaultsUrl: resource("defaults"),
                profileUrls: { dev: resource("dev"), prod: resource("prod"), "prod-hardened": resource("prod-hardened"), "prod-in-memory": resource("prod-in-memory") },
                staticClientsUrl: new URL("./apps/api-v1/resources/authorised-clients.json", import.meta.url)
            });
            console.log(JSON.stringify({ requests: configuration.ice.rateLimit.requests, windowMs: configuration.ice.rateLimit.windowMs, cacheTtlMs: configuration.ice.cacheTtlMs, mode: configuration.ice.mode, frozen: Object.isFrozen(configuration.ice.rateLimit) }));
        `;
            const actualChildRequests = execFileSync('/bin/sh', [
                '-c',
                `${commandPrefix} deno eval --config apps/api-v1/deno.json '${configurationProbe}'`
            ], {
                cwd: new URL('../../../apps/rallar-black-box/', import.meta.url),
                encoding: 'utf8',
                env: { ...process.env, RALLAR_ICE_RATE_LIMIT_REQUESTS: '999' }
            });
            expect(JSON.parse(actualChildRequests)).toEqual({ requests: expectedRequests, windowMs: 60_000, cacheTtlMs: 300_000, mode: 'local', frozen: true });
            expect(server.reuseExistingServer).toBe(false);
        }
    );

    it.each([
        { RALLAR_ICE_RATE_LIMIT_REQUESTS: '101' },
        { RALLAR_ICE_RATE_LIMIT_REQUESTS: '0' },
        { RALLAR_BLACK_BOX_RTC_CASE_ID: 'default', RALLAR_ICE_RATE_LIMIT_REQUESTS: '101' },
        {
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            RALLAR_ICE_RATE_LIMIT_REQUESTS: '20'
        },
        { RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100', RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1', RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '99' },
        {
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1'
        },
        { RALLAR_BLACK_BOX_RTC_CASE_ID: 'unknown' }
    ])('rejects inherited, malformed or contradictory policy before child launch: %j', async (environment) => {
        const selectedCaseId = environment.RALLAR_BLACK_BOX_RTC_CASE_ID;
        const selectedEnvironment = selectedCaseId === 'default' || selectedCaseId === 'retention-100'
            ? { ...await createPredeclaredSelection(selectedCaseId), ...environment }
            : environment;
        const admittedAttempt = selectedCaseId === 'default' || selectedCaseId === 'retention-100'
            ? await loadLiveRtcPerformanceAttempt({ repoRoot: process.cwd(), environment: selectedEnvironment })
            : null;
        expect(() =>
            createDefaultFullStackApiV1WebServer({
                mode: 'memory',
                environment: selectedEnvironment,
                admittedRtcCaseId: admittedAttempt?.locator.caseId ?? null
            })
        ).toThrow(/ICE fixture/);
    });

    it.each([
        { RALLAR_BLACK_BOX_RTC_BASELINE_ID: '20261009T204500000Z-0123456789ab-e3-memory-local' },
        { RALLAR_BLACK_BOX_RTC_INPUT_KEY: 'e3-memory-retention-100' },
        { RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: 'retained' },
        { RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '1' },
        {
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            RALLAR_ICE_RATE_LIMIT_REQUESTS: '101'
        }
    ])('refuses locator input without canonical admission through the default factory: %j', (environment) => {
        expect(() => createDefaultFullStackApiV1WebServer({ mode: 'memory', environment })).toThrow(/canonical predeclared attempt admission/);
    });

    it.each([
        {
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            RALLAR_ICE_RATE_LIMIT_REQUESTS: '101'
        },
        { RALLAR_BLACK_BOX_RTC_BASELINE_ID: '20261009T204500000Z-0123456789ab-e3-memory-local' },
        { RALLAR_BLACK_BOX_RTC_INPUT_KEY: 'e3-memory-retention-100', RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1', RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100' },
        { RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: 'retained' },
        { RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '1' },
        {
            RALLAR_BLACK_BOX_RTC_BASELINE_ID: '20261009T204500000Z-0123456789ab-e3-memory-local',
            RALLAR_BLACK_BOX_RTC_CASE_ID: 'retention-100',
            RALLAR_BLACK_BOX_RTC_INPUT_KEY: 'e3-memory-retention-100',
            RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: 'retained',
            RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '1x',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
        }
    ])('rejects config loading for a partial or invalid canonical locator: %j', async (environment) => {
        for (const name of Object.keys(process.env)) {
            if (name.startsWith('RALLAR_') || name.startsWith('VITE_RALLAR_')) {
                vi.stubEnv(name, undefined);
            }
        }
        vi.stubEnv('RALLAR_BLACK_BOX_FULL_STACK', '1');
        vi.stubEnv('RALLAR_BLACK_BOX_API_MODE', 'memory');
        for (const [name, value] of Object.entries(environment)) {
            vi.stubEnv(name, value);
        }
        vi.resetModules();
        await expect(import('../../../apps/rallar-black-box/playwright.full-stack.config.ts')).rejects.toThrow(/Live RTC evidence|OUTER_ORDINAL/);
    });

    it.each([
        { RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '999' },
        { RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: 'other' },
        { RALLAR_BLACK_BOX_RTC_INPUT_KEY: 'e3-memory-default' },
        { RALLAR_BLACK_BOX_RTC_BASELINE_ID: '../escape' },
        { RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '0' },
        { RALLAR_BLACK_BOX_RTC_CASE_ID: 'other' }
    ])('rejects config loading for a complete locator that is invalid or not predeclared: %j', async (override) => {
        const environment = {
            ...await createPredeclaredSelection('retention-100'),
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            ...override
        };
        for (const name of Object.keys(process.env)) {
            if (name.startsWith('RALLAR_') || name.startsWith('VITE_RALLAR_')) {
                vi.stubEnv(name, undefined);
            }
        }
        vi.stubEnv('RALLAR_BLACK_BOX_FULL_STACK', '1');
        vi.stubEnv('RALLAR_BLACK_BOX_API_MODE', 'memory');
        for (const [name, value] of Object.entries(environment)) {
            vi.stubEnv(name, value);
        }
        vi.resetModules();
        await expect(import('../../../apps/rallar-black-box/playwright.full-stack.config.ts')).rejects.toThrow(/Live RTC evidence|OUTER_ORDINAL/);
    });

    it.each([
        { recorder: 'owned', refusal: /Production/ },
        { recorder: 'missing', refusal: /exact current-attempt recorder directory/ }
    ])('rejects historical E3 config with $recorder recorder at its intended guard', {
        timeout: CONFIG_LOADER_TEST_TIMEOUT_MS
    }, async ({ recorder, refusal }) => {
        const selection = await createPredeclaredSelection('retention-100');
        const recorderRoot = join(process.cwd(), 'tmp/perf/rtc-b06-recorder', selection.RALLAR_BLACK_BOX_RTC_BASELINE_ID!);
        const recorderDirectory = join(recorderRoot, 'retention-100/retained-1');
        onTestFinished(() => rm(recorderRoot, { recursive: true, force: true }));
        await mkdir(recorderDirectory, { recursive: true });
        const environment = {
            ...selection,
            RALLAR_BLACK_BOX_STORAGE_DIR: recorder === 'owned' ? recorderDirectory : undefined,
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
            RALLAR_ICE_RATE_LIMIT_REQUESTS: '101'
        };
        for (const name of Object.keys(process.env)) {
            if (name.startsWith('RALLAR_') || name.startsWith('VITE_RALLAR_')) {
                vi.stubEnv(name, undefined);
            }
        }
        vi.stubEnv('RALLAR_BLACK_BOX_FULL_STACK', '1');
        vi.stubEnv('RALLAR_BLACK_BOX_API_MODE', 'memory');
        for (const [name, value] of Object.entries(environment)) {
            vi.stubEnv(name, value);
        }
        vi.resetModules();
        await expect(import('../../../apps/rallar-black-box/playwright.full-stack.config.ts')).rejects.toThrow(refusal);
    });

    it('allows CI configs to disable existing web server reuse', () => {
        const server = createDefaultFullStackApiV1WebServer({
            mode: 'postgres',
            reuseExistingServer: false
        });

        expect(server.reuseExistingServer).toBe(false);
    });

    it('forces a fresh Postgres process for backend-authoritative acceptance', () => {
        const server = createDefaultFullStackApiV1WebServer({
            mode: 'postgres',
            reuseExistingServer: true,
            requireFreshPostgres: true
        });

        expect(server.reuseExistingServer).toBe(false);
        expect(server.command).toContain('RALLAR_SQL_BACKEND=postgres');
        expect(() =>
            createDefaultFullStackApiV1WebServer({
                mode: 'memory',
                requireFreshPostgres: true
            })
        ).toThrow(/Fresh Postgres API isolation requires mode postgres/);
    });

    it('rejects reachable malformed or mismatched configured-service evidence', () => {
        expect(() =>
            assertFullStackReadinessHttpEvidence({
                service: 'API',
                ok: true,
                status: 200,
                statusText: 'OK'
            })
        ).not.toThrow();
        expect(() =>
            assertFullStackReadinessHttpEvidence({
                service: 'API',
                ok: false,
                status: 503,
                statusText: 'Service Unavailable'
            })
        ).toThrow(/Configured API readiness returned HTTP 503 Service Unavailable/);
        expect(() =>
            assertFullStackReadinessHttpEvidence({
                service: 'control',
                ok: false,
                status: 426,
                statusText: 'Upgrade Required'
            })
        ).toThrow(/Configured control readiness returned HTTP 426 Upgrade Required/);

        expect(() =>
            assertFullStackApiConfigEvidence({
                apiBaseUrl: 'http://localhost:8080',
                wsBaseUrl: 'ws://localhost:8080',
                endpoints: { createWs: '/api/ws/:id' }
            }, 'http://localhost:8080')
        ).not.toThrow();
        expect(() =>
            assertFullStackControlHealthEvidence({
                ok: true,
                app: 'rallar-black-box-control-server',
                protocolVersion: 1
            })
        ).not.toThrow();

        expect(() => assertFullStackApiConfigEvidence('not-an-object', 'http://localhost:8080'))
            .toThrow(/API configuration must be a JSON object/);
        expect(() =>
            assertFullStackApiConfigEvidence({
                apiBaseUrl: 'http://localhost:18080',
                wsBaseUrl: 'ws://localhost:18080',
                endpoints: { createWs: '/api/ws/:id' }
            }, 'http://localhost:8080')
        ).toThrow(/apiBaseUrl/);
        expect(() =>
            assertFullStackControlHealthEvidence({
                ok: true,
                app: 'wrong-control-server',
                protocolVersion: 1
            })
        ).toThrow(/app/);
        expect(() =>
            assertFullStackControlHealthEvidence({
                ok: true,
                app: 'rallar-black-box-control-server',
                protocolVersion: 2
            })
        ).toThrow(/protocolVersion/);
    });

    it('validates each reachable probe before classifying an absent peer as unavailable', async () => {
        const unavailable = { kind: 'unavailable' as const };
        const reachable = (value: unknown) => ({
            kind: 'reachable' as const,
            ok: true,
            status: 200,
            statusText: 'OK',
            readJson: async () => value
        });

        await expect(evaluateFullStackConfiguredServiceEvidence({
            api: {
                ...reachable({}),
                ok: false,
                status: 503,
                statusText: 'Service Unavailable'
            },
            control: unavailable,
            expectedApiBaseUrl: 'http://localhost:8080'
        })).rejects.toThrow(/Configured API readiness returned HTTP 503/);
        await expect(evaluateFullStackConfiguredServiceEvidence({
            api: reachable('malformed-api-config'),
            control: unavailable,
            expectedApiBaseUrl: 'http://localhost:8080'
        })).rejects.toThrow(/API configuration must be a JSON object/);
        await expect(evaluateFullStackConfiguredServiceEvidence({
            api: unavailable,
            control: reachable({
                ok: true,
                app: 'rallar-black-box-control-server',
                protocolVersion: 2
            }),
            expectedApiBaseUrl: 'http://localhost:8080'
        })).rejects.toThrow(/protocolVersion/);
        await expect(evaluateFullStackConfiguredServiceEvidence({
            api: reachable({
                apiBaseUrl: 'http://localhost:8080',
                wsBaseUrl: 'ws://localhost:8080',
                endpoints: { createWs: '/api/ws/:id' }
            }),
            control: unavailable,
            expectedApiBaseUrl: 'http://localhost:8080'
        })).resolves.toBe('unavailable');
    });

    it('derives HTTPS API/WS URLs and reverse local CORS aliases in the launched server configuration', () => {
        const server = createDefaultFullStackApiV1WebServer({
            mode: 'memory',
            apiBaseUrl: 'https://rallar.example.test/',
            spaBaseUrl: 'http://127.0.0.1:5178',
            environment: {}
        });
        expect(server.command).toContain('RALLAR_API_BASE_URL=https://rallar.example.test RALLAR_WS_BASE_URL=wss://rallar.example.test');
        expect(server.command).toContain('CORS_ORIGINS=http://127.0.0.1:5178,http://localhost:5178');
    });

    it('rejects unknown full-stack API server modes', () => {
        expect(() => readFullStackApiServerMode({ RALLAR_BLACK_BOX_API_MODE: 'sqlite' }))
            .toThrow(/RALLAR_BLACK_BOX_API_MODE must be one of postgres, memory/);
    });
});

function startFullStackApiCaptureConfigProbe(
    configName: 'full-stack' | 'worker-capture' | 'exhaustive',
    environment: NodeJS.ProcessEnv
): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        String.raw`
        import config from ${JSON.stringify(`./apps/rallar-black-box/playwright.${configName}.config.ts`)};
        const api = config.webServer[0];
        const timing = /(?:^|\s)RALLAR_TIMING_LOGS=(true|false)(?:\s|$)/.exec(api.command);
        const phase = /(?:^|\s)RALLAR_APP_INBOX_PHASE_TIMING=(true|false)(?:\s|$)/.exec(api.command);
        const wrapper = api.command.includes('run-full-stack-api-with-timing.ts');
        process.stdout.write(JSON.stringify({
            wrapper,
            direct: !wrapper && /(?:^|\s)deno\s+run/.test(api.command),
            timingLogs: timing === null ? null : timing[1] === 'true',
            appInboxPhaseTiming: phase === null ? null : phase[1] === 'true',
            reuseExistingServer: api.reuseExistingServer,
            gracefulShutdown: api.gracefulShutdown?.signal ?? null
        }));
    `
    ], {
        encoding: 'utf8',
        env: { ...captureProbeEnvironment, ...environment },
        timeout: CONFIG_LOADER_TEST_TIMEOUT_MS
    });
}

async function createPredeclaredSelection(caseId: string): Promise<NodeJS.ProcessEnv> {
    // Synthetic unit initialization: never a live receipt or accepted performance cohort.
    const baselineId = `20261009T204500000Z-${randomBytes(6).toString('hex')}-e3-memory-local`;
    const baselineRoot = join(process.cwd(), 'tmp', 'perf', 'rtc-baseline', baselineId);
    onTestFinished(() => rm(baselineRoot, { recursive: true, force: true }));
    await mkdir(baselineRoot, { recursive: true });
    await writeFile(join(baselineRoot, 'manifest.json'), JSON.stringify(toPredeclaredSelectionManifest(baselineId)));
    await writeFile(
        join(baselineRoot, 'environment.json'),
        JSON.stringify({
            schema: 'rallar.rtc-baseline.environment.v1',
            baselineId,
            workloadIds: ['RTC-B06'],
            environmentId: 'E3-memory',
            repeatLink: null,
            conditionalEnvironmentDecisions: [],
            observation: predeclaredEnvironmentObservation
        })
    );
    return {
        RALLAR_BLACK_BOX_RTC_BASELINE_ID: baselineId,
        RALLAR_BLACK_BOX_RTC_CASE_ID: caseId,
        RALLAR_BLACK_BOX_RTC_INPUT_KEY: `e3-memory-${caseId}`,
        RALLAR_BLACK_BOX_RTC_INTENDED_PHASE: 'retained',
        RALLAR_BLACK_BOX_RTC_OUTER_ORDINAL: '1'
    };
}

function toPredeclaredSelectionManifest(baselineId: string): ApiJsonObject {
    const cases = ['default', 'all-scenarios', 'retention-100'].map((caseId) => ({
        workloadId: 'RTC-B06',
        caseId,
        inputKey: `e3-memory-${caseId}`
    }));
    return {
        schema: 'rallar.rtc-baseline.manifest.v1',
        request: {
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId,
            workloadIds: ['RTC-B06'],
            environmentId: 'E3-memory',
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: []
        },
        workloadIds: ['RTC-B06'],
        cases,
        outerAttempts: cases.map((entry) => ({
            ...entry,
            environmentId: 'E3-memory',
            intendedPhase: 'retained',
            outerOrdinal: 1,
            sampleIds: [`rtc-b06-${entry.caseId}-${entry.inputKey}-retained-001-001`]
        })),
        expectedCohorts: [],
        repeatLink: null
    };
}
