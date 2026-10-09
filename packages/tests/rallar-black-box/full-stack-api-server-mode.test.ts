import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
    assertFullStackApiConfigEvidence,
    assertFullStackControlHealthEvidence,
    assertFullStackReadinessHttpEvidence,
    createDefaultFullStackApiV1WebServer,
    createFullStackApiProfileEnvBlock,
    createFullStackApiUrlEnvBlock,
    createFullStackSpaCorsOrigins,
    evaluateFullStackConfiguredServiceEvidence,
    readFullStackApiBaseUrl,
    readFullStackApiServerMode,
    readFullStackSpaBaseUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import type { ApiJsonValue } from '../../shared/api/api-json-value.ts';

describe('rallar-black-box full-stack API server mode', () => {
    it.each(['', 'false', 'true'])('routes capture=%s only through the local memory lifecycle', (capture) => {
        const result = spawnSync(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            `import config from './apps/rallar-black-box/playwright.full-stack.config.ts';
             process.stdout.write(JSON.stringify(config.webServer));`
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                CI: '1',
                RALLAR_BLACK_BOX_FULL_STACK: '1',
                RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '1',
                RALLAR_BLACK_BOX_API_MODE: 'memory',
                RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER: '0',
                RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING: capture,
                RALLAR_BLACK_BOX_STORAGE_DIR: '/tmp/capture recorder'
            }
        });
        expect(result.status).toBe(0);
        const api = JSON.parse(result.stdout)[0];
        if (capture === 'true') {
            expect(api.command).toContain('RALLAR_TIMING_LOGS=true RALLAR_APP_INBOX_PHASE_TIMING=true');
            expect(api.command).toContain(
                'node --import tsx apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts \'/tmp/capture recorder\' -- deno run'
            );
            expect(api.command).toContain('--allow-read apps/api-v1/src/main.ts');
            expect(api).toMatchObject({ reuseExistingServer: false, timeout: 120_000, gracefulShutdown: { signal: 'SIGTERM', timeout: 7_000 } });
        }
        else {
            expect(api.command).not.toContain('run-full-stack-api-with-timing');
            expect(api.command).not.toContain('RALLAR_TIMING_LOGS=');
            expect(api).not.toHaveProperty('gracefulShutdown');
        }
    });

    it('preserves the ordinary exhaustive consumer with no diagnostic capture', () => {
        const result = spawnSync(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            `import config from './apps/rallar-black-box/playwright.exhaustive.config.ts';
             process.stdout.write(JSON.stringify(config.webServer));`
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
        const api = JSON.parse(result.stdout)[0];
        expect(api.command).toContain('RALLAR_LOGIN_USER_RATE_LIMIT=123 CORS_ORIGINS=');
        expect(api.command).toContain('deno run --env-file=apps/api-v1/.env.local');
        expect(api.command).not.toContain('run-full-stack-api-with-timing');
        expect(api).toMatchObject({ url: 'http://localhost:8080/api/config', reuseExistingServer: false, timeout: 90_000 });
        expect(api).not.toHaveProperty('gracefulShutdown');
    });

    it.each([
        { RALLAR_BLACK_BOX_FULL_STACK: '0' },
        { RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '0' },
        { RALLAR_BLACK_BOX_API_MODE: 'postgres' },
        { RALLAR_BLACK_BOX_STORAGE_DIR: '' },
        { RALLAR_BLACK_BOX_STORAGE_DIR: 'relative/recorder' }
    ])('rejects capture outside the local lifecycle %s', (override) => {
        const result = spawnSync(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            'import \'./apps/rallar-black-box/playwright.full-stack.config.ts\';'
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                RALLAR_BLACK_BOX_FULL_STACK: '1',
                RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '1',
                RALLAR_BLACK_BOX_API_MODE: 'memory',
                RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING: 'true',
                RALLAR_BLACK_BOX_STORAGE_DIR: '/tmp/recorder',
                RALLAR_BLACK_BOX_LIVE_RTC_CLUSTER: '0',
                ...override
            }
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Setup timing capture requires');
    });

    it.each([
        { headless: '1', workspace: 'rallar-black-box-headless', readiness: '/headless/' },
        { headless: '', workspace: 'rallar-black-box', readiness: '' }
    ])('selects $workspace at the configured SPA port with fresh CI ownership', ({ headless, workspace, readiness }) => {
        const result = spawnSync(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            `import config from './apps/rallar-black-box/playwright.full-stack.config.ts';
             process.stdout.write(JSON.stringify(config.webServer));`
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
        const servers = JSON.parse(result.stdout);
        expect(servers).toHaveLength(3);
        expect(servers[1]).toMatchObject({
            command: `cd ../.. && npm --workspace ${workspace} run dev -- --port 5376 --force`,
            url: `http://127.0.0.1:5376${readiness}`,
            reuseExistingServer: false
        });
        expect(servers.every((server: { reuseExistingServer: boolean; }) => !server.reuseExistingServer)).toBe(true);
    });

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
        const reachable = (value: ApiJsonValue) => ({
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

    it('keeps the canonical full-stack API profile and fixture credentials in one place', () => {
        expect(createFullStackApiProfileEnvBlock()).toBe(
            'RALLAR_API_CONFIGURATION_PROFILE=prod-in-memory RALLAR_LOGIN_USER_RATE_LIMIT=100 RALLAR_AUTH_CREDENTIAL_SECRET=local-rallar-full-stack-auth-credential-secret-v1 RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET=local-rallar-full-stack-operator-secret-v1'
        );
    });

    it('keeps API and WS base URL overrides in one place', () => {
        expect(createFullStackApiUrlEnvBlock('https://rallar.example.test/')).toBe(
            'RALLAR_API_BASE_URL=https://rallar.example.test RALLAR_WS_BASE_URL=wss://rallar.example.test'
        );
    });

    it('derives same-host local SPA CORS aliases', () => {
        expect(createFullStackSpaCorsOrigins('http://localhost:5177/')).toBe(
            'http://localhost:5177,http://127.0.0.1:5177'
        );
        expect(createFullStackSpaCorsOrigins('http://127.0.0.1:5178')).toBe(
            'http://127.0.0.1:5178,http://localhost:5178'
        );
    });

    it('rejects unknown full-stack API server modes', () => {
        expect(() => readFullStackApiServerMode({ RALLAR_BLACK_BOX_API_MODE: 'sqlite' }))
            .toThrow(/RALLAR_BLACK_BOX_API_MODE must be one of postgres, memory/);
    });
});
