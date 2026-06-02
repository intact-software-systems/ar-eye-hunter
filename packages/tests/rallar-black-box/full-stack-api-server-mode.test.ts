import { describe, expect, it } from 'vitest';
import {
  createFullStackApiUrlEnvBlock,
  createFullStackApiV1WebServer,
  createFullStackMemoryEnvBlock,
  readFullStackApiBaseUrl,
  readFullStackApiServerMode,
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';

describe('rallar-black-box full-stack API server mode', () => {
  it('defaults to the existing Postgres-backed full-stack API server mode', () => {
    expect(readFullStackApiServerMode({})).toBe('postgres');
    expect(readFullStackApiBaseUrl({})).toBe('http://localhost:8080');

    const server = createFullStackApiV1WebServer({
      mode: 'postgres',
      apiBaseUrl: 'http://localhost:8080/',
    });

    expect(server.url).toBe('http://localhost:8080/api/config');
    expect(server.command).toContain('--env-file=apps/api-v1/.env.local');
    expect(server.command).toContain('RALLAR_API_BASE_URL=http://localhost:8080');
    expect(server.command).toContain('RALLAR_WS_BASE_URL=ws://localhost:8080');
    expect(server.command).not.toContain('RALLAR_SQL_BACKEND=pglite-memory');
  });

  it('builds an API-v1 memory-mode full-stack server command with no DATABASE_URL requirement', () => {
    const server = createFullStackApiV1WebServer({
      mode: 'memory',
      apiBaseUrl: 'http://localhost:18080',
    });

    expect(server.url).toBe('http://localhost:18080/api/config');
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

  it('rejects unknown full-stack API server modes', () => {
    expect(() => readFullStackApiServerMode({ RALLAR_BLACK_BOX_API_MODE: 'sqlite' }))
      .toThrow(/RALLAR_BLACK_BOX_API_MODE must be one of postgres, memory/);
  });
});
