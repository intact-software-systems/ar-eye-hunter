import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    mkdir,
    rm,
    writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    assertFullStackApiConfigEvidence,
    assertFullStackControlHealthEvidence,
    assertFullStackReadinessHttpEvidence,
    createDefaultFullStackApiV1WebServer,
    evaluateFullStackConfiguredServiceEvidence,
    readFullStackApiBaseUrl,
    readFullStackApiServerMode,
    readFullStackSpaBaseUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import { loadLiveRtcPerformanceAttempt } from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';

const CONFIG_LOADER_TEST_TIMEOUT_MS = 30_000;

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

    it('rejects config loading for historical E3 admission without production binding', {
        timeout: CONFIG_LOADER_TEST_TIMEOUT_MS
    }, async () => {
        const environment = {
            ...await createPredeclaredSelection('retention-100'),
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
        await expect(import('../../../apps/rallar-black-box/playwright.full-stack.config.ts')).rejects.toThrow(/Production/);
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

async function createPredeclaredSelection(caseId: string): Promise<Record<string, string>> {
    // Synthetic unit initialization: never a live receipt or accepted performance cohort.
    const baselineId = `20261009T204500000Z-${randomBytes(6).toString('hex')}-e3-memory-local`;
    const baselineRoot = join(process.cwd(), 'tmp', 'perf', 'rtc-baseline', baselineId);
    onTestFinished(() => rm(baselineRoot, { recursive: true, force: true }));
    await mkdir(baselineRoot, { recursive: true });
    const cases = ['default', 'all-scenarios', 'retention-100'].map((caseId) => ({
        workloadId: 'RTC-B06',
        caseId,
        inputKey: `e3-memory-${caseId}`
    }));
    const manifest = {
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
    await writeFile(join(baselineRoot, 'manifest.json'), JSON.stringify(manifest));
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
