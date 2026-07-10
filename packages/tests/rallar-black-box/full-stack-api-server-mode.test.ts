import { describe, expect, it } from 'vitest';
import {
  assertFullStackApiConfigEvidence,
  assertFullStackControlHealthEvidence,
  assertFullStackReadinessHttpEvidence,
  createFullStackApiUrlEnvBlock,
  createFullStackApiV1WebServer,
  createFullStackMemoryEnvBlock,
  createFullStackSpaCorsOrigins,
  evaluateFullStackConfiguredServiceEvidence,
  readFullStackApiBaseUrl,
  readFullStackApiServerMode,
  readFullStackSpaBaseUrl,
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';

describe('rallar-black-box full-stack API server mode', () => {
  it('defaults to the existing Postgres-backed full-stack API server mode', () => {
    expect(readFullStackApiServerMode({})).toBe('postgres');
    expect(readFullStackApiBaseUrl({})).toBe('http://localhost:8080');
    expect(readFullStackSpaBaseUrl({})).toBe('http://localhost:5176');

    const server = createFullStackApiV1WebServer({
      mode: 'postgres',
      apiBaseUrl: 'http://localhost:8080/',
      spaBaseUrl: 'http://localhost:5178/',
    });

    expect(server.url).toBe('http://localhost:8080/api/config');
    expect(server.command).toContain('CORS_ORIGINS=http://localhost:5178,http://127.0.0.1:5178');
    expect(server.command).toContain('--env-file=apps/api-v1/.env.local');
    expect(server.command).toContain('RALLAR_API_BASE_URL=http://localhost:8080');
    expect(server.command).toContain('RALLAR_WS_BASE_URL=ws://localhost:8080');
    expect(server.command).toContain('RALLAR_SQL_BACKEND=postgres');
    expect(server.command).not.toContain('RALLAR_SQL_BACKEND=pglite-memory');
  });

  it('builds an API-v1 memory-mode full-stack server command with no DATABASE_URL requirement', () => {
    const server = createFullStackApiV1WebServer({
      mode: 'memory',
      apiBaseUrl: 'http://localhost:18080',
      spaBaseUrl: 'http://localhost:5177',
    });

    expect(server.url).toBe('http://localhost:18080/api/config');
    expect(server.command).toContain('CORS_ORIGINS=http://localhost:5177,http://127.0.0.1:5177');
    expect(server.command).toContain('PORT=18080');
    expect(server.command).toContain('RALLAR_API_BASE_URL=http://localhost:18080');
    expect(server.command).toContain('RALLAR_WS_BASE_URL=ws://localhost:18080');
    expect(server.command).toContain('RALLAR_SQL_BACKEND=pglite-memory');
    expect(server.command).toContain('RALLAR_PGLITE_SCHEMA_INIT=auto');
    expect(server.command).toContain('RALLAR_DB_PUBSUB=local');
    expect(server.command).toContain('RALLAR_ICE_MODE=local');
    expect(server.command).toContain('RALLAR_LOGIN_USER_RATE_LIMIT=100');
    expect(server.command).not.toContain('DATABASE_URL');
    expect(server.command).not.toContain('--env-file=');
  });

  it('allows CI configs to disable existing web server reuse', () => {
    const server = createFullStackApiV1WebServer({
      mode: 'postgres',
      reuseExistingServer: false,
    });

    expect(server.reuseExistingServer).toBe(false);
  });

  it('forces a fresh Postgres process for backend-authoritative acceptance', () => {
    const server = createFullStackApiV1WebServer({
      mode: 'postgres',
      reuseExistingServer: true,
      requireFreshPostgres: true,
    });

    expect(server.reuseExistingServer).toBe(false);
    expect(server.command).toContain('RALLAR_SQL_BACKEND=postgres');
    expect(() => createFullStackApiV1WebServer({
      mode: 'memory',
      requireFreshPostgres: true,
    })).toThrow(/Fresh Postgres API isolation requires mode postgres/);
  });

  it('rejects reachable malformed or mismatched configured-service evidence', () => {
    expect(() => assertFullStackReadinessHttpEvidence({
      service: 'API',
      ok: true,
      status: 200,
      statusText: 'OK',
    })).not.toThrow();
    expect(() => assertFullStackReadinessHttpEvidence({
      service: 'API',
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })).toThrow(/Configured API readiness returned HTTP 503 Service Unavailable/);
    expect(() => assertFullStackReadinessHttpEvidence({
      service: 'control',
      ok: false,
      status: 426,
      statusText: 'Upgrade Required',
    })).toThrow(/Configured control readiness returned HTTP 426 Upgrade Required/);

    expect(() => assertFullStackApiConfigEvidence({
      apiBaseUrl: 'http://localhost:8080',
      wsBaseUrl: 'ws://localhost:8080',
      endpoints: { createWs: '/api/ws/:id' },
    }, 'http://localhost:8080')).not.toThrow();
    expect(() => assertFullStackControlHealthEvidence({
      ok: true,
      app: 'rallar-black-box-control-server',
      protocolVersion: 1,
    })).not.toThrow();

    expect(() => assertFullStackApiConfigEvidence('not-an-object', 'http://localhost:8080'))
      .toThrow(/API configuration must be a JSON object/);
    expect(() => assertFullStackApiConfigEvidence({
      apiBaseUrl: 'http://localhost:18080',
      wsBaseUrl: 'ws://localhost:18080',
      endpoints: { createWs: '/api/ws/:id' },
    }, 'http://localhost:8080')).toThrow(/apiBaseUrl/);
    expect(() => assertFullStackControlHealthEvidence({
      ok: true,
      app: 'wrong-control-server',
      protocolVersion: 1,
    })).toThrow(/app/);
    expect(() => assertFullStackControlHealthEvidence({
      ok: true,
      app: 'rallar-black-box-control-server',
      protocolVersion: 2,
    })).toThrow(/protocolVersion/);
  });

  it('validates each reachable probe before classifying an absent peer as unavailable', async () => {
    const unavailable = { kind: 'unavailable' as const };
    const reachable = (value: unknown) => ({
      kind: 'reachable' as const,
      ok: true,
      status: 200,
      statusText: 'OK',
      readJson: async () => value,
    });

    await expect(evaluateFullStackConfiguredServiceEvidence({
      api: {
        ...reachable({}),
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      },
      control: unavailable,
      expectedApiBaseUrl: 'http://localhost:8080',
    })).rejects.toThrow(/Configured API readiness returned HTTP 503/);
    await expect(evaluateFullStackConfiguredServiceEvidence({
      api: reachable('malformed-api-config'),
      control: unavailable,
      expectedApiBaseUrl: 'http://localhost:8080',
    })).rejects.toThrow(/API configuration must be a JSON object/);
    await expect(evaluateFullStackConfiguredServiceEvidence({
      api: unavailable,
      control: reachable({
        ok: true,
        app: 'rallar-black-box-control-server',
        protocolVersion: 2,
      }),
      expectedApiBaseUrl: 'http://localhost:8080',
    })).rejects.toThrow(/protocolVersion/);
    await expect(evaluateFullStackConfiguredServiceEvidence({
      api: reachable({
        apiBaseUrl: 'http://localhost:8080',
        wsBaseUrl: 'ws://localhost:8080',
        endpoints: { createWs: '/api/ws/:id' },
      }),
      control: unavailable,
      expectedApiBaseUrl: 'http://localhost:8080',
    })).resolves.toBe('unavailable');
  });

  it('keeps the documented memory env block in one place', () => {
    expect(createFullStackMemoryEnvBlock()).toBe(
      'RALLAR_SQL_BACKEND=pglite-memory RALLAR_PGLITE_DATA_DIR=memory:// RALLAR_PGLITE_SCHEMA_INIT=auto RALLAR_DB_PUBSUB=local RALLAR_ICE_MODE=local RALLAR_LOGIN_USER_RATE_LIMIT=100',
    );
  });

  it('keeps API and WS base URL overrides in one place', () => {
    expect(createFullStackApiUrlEnvBlock('https://rallar.example.test/')).toBe(
      'RALLAR_API_BASE_URL=https://rallar.example.test RALLAR_WS_BASE_URL=wss://rallar.example.test',
    );
  });

  it('derives same-host local SPA CORS aliases', () => {
    expect(createFullStackSpaCorsOrigins('http://localhost:5177/')).toBe(
      'http://localhost:5177,http://127.0.0.1:5177',
    );
    expect(createFullStackSpaCorsOrigins('http://127.0.0.1:5178')).toBe(
      'http://127.0.0.1:5178,http://localhost:5178',
    );
  });

  it('rejects unknown full-stack API server modes', () => {
    expect(() => readFullStackApiServerMode({ RALLAR_BLACK_BOX_API_MODE: 'sqlite' }))
      .toThrow(/RALLAR_BLACK_BOX_API_MODE must be one of postgres, memory/);
  });
});
