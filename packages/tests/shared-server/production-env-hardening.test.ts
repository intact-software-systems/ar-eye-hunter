import { describe, expect, it } from 'vitest';
import {
  collectApiV1ProductionEnvErrors,
  collectBlackBoxControlProductionEnvErrors,
  collectRelicProductionEnvErrors,
  isProductionHardeningEnabled,
} from '@shared-server/http/production-env-hardening.ts';

describe('production env hardening validation', () => {
  it('enables hardening from explicit flag or production environment', () => {
    expect(isProductionHardeningEnabled(env({}))).toBe(false);
    expect(isProductionHardeningEnabled(env({ RALLAR_PRODUCTION_HARDENING: '1' }))).toBe(true);
    expect(isProductionHardeningEnabled(env({ ENVIRONMENT: 'prod' }))).toBe(true);
    expect(isProductionHardeningEnabled(env({ ENVIRONMENT: 'production' }))).toBe(true);
  });

  it('requires API-v1 production guardrails without exposing secret values', () => {
    const errors = collectApiV1ProductionEnvErrors(env({
      RALLAR_PRODUCTION_HARDENING: '1',
      RALLAR_SQL_BACKEND: 'pglite-memory',
      DATABASE_URL: 'postgres://secret-user:secret-pass@db.example.test/rallar',
      CORS_ORIGINS: '*,http://localhost:5173',
      AUTH_ADMIN_CLIENT_IDS: 'admin',
    }));

    expect(errors.map((error) => error.variable)).toEqual(expect.arrayContaining([
      'RALLAR_SQL_BACKEND',
      'CORS_ORIGINS',
      'RALLAR_STATE_STRICT_READ_AUTH',
      'AUTH_REGISTRATION_MODE',
      'AUTH_ADMIN_CLIENT_IDS',
      'AUTH_STATIC_CLIENTS_MODE',
      'RALLAR_AUTH_CREDENTIAL_SECRET',
      'RALLAR_ICE_MODE',
      'METERED_APP_NAME',
      'METERED_API_KEY',
      'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET',
      'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS',
      'RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS',
    ]));
    expect(JSON.stringify(errors)).not.toContain('secret-pass');
  });

  it('accepts a hardened API-v1 env', () => {
    expect(collectApiV1ProductionEnvErrors(env(hardenedApiEnv()))).toEqual([]);
  });

  it('rejects wildcard HTTPS hostnames in production origins', () => {
    expect(collectApiV1ProductionEnvErrors(env({
      ...hardenedApiEnv(),
      CORS_ORIGINS: 'https://*.example.test',
    })).map((error) => error.variable)).toContain('CORS_ORIGINS');
    expect(collectBlackBoxControlProductionEnvErrors(env({
      RALLAR_PRODUCTION_HARDENING: '1',
      RALLAR_BLACK_BOX_ALLOWED_ORIGINS: 'https://*.example.test',
      RALLAR_BLACK_BOX_REQUIRE_TLS: '1',
      RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1',
      RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
      RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret',
      RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS: 'api.example.test',
      RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS: 'ws.example.test',
      RALLAR_BLACK_BOX_STORAGE_DIR: '/var/lib/rallar-black-box',
      RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '100',
    })).map((error) => error.variable)).toContain('RALLAR_BLACK_BOX_ALLOWED_ORIGINS');
  });

  it('requires Relic REST group policy when Relic runs hardened', () => {
    expect(collectRelicProductionEnvErrors(env(hardenedApiEnv())).map((error) => error.variable))
      .toContain('RELIC_REST_AUTH_MODE');
    expect(collectRelicProductionEnvErrors(env({
      ...hardenedApiEnv(),
      RELIC_REST_AUTH_MODE: 'group-policy',
    }))).toEqual([]);
  });

  it('requires black-box control read/admin/run token and egress guardrails', () => {
    const errors = collectBlackBoxControlProductionEnvErrors(env({
      RALLAR_PRODUCTION_HARDENING: '1',
      RALLAR_BLACK_BOX_ALLOWED_ORIGINS: '*',
      RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret',
    }));

    expect(errors.map((error) => error.variable)).toEqual(expect.arrayContaining([
      'RALLAR_BLACK_BOX_ALLOWED_ORIGINS',
      'RALLAR_BLACK_BOX_REQUIRE_TLS',
      'RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN',
      'RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN',
      'RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS',
      'RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS',
      'RALLAR_BLACK_BOX_STORAGE_DIR',
      'RALLAR_BLACK_BOX_RETENTION_MAX_RUNS',
    ]));
    expect(JSON.stringify(errors)).not.toContain('operator-secret');
  });

  it('accepts a hardened black-box control env', () => {
    expect(collectBlackBoxControlProductionEnvErrors(env({
      RALLAR_PRODUCTION_HARDENING: '1',
      RALLAR_BLACK_BOX_ALLOWED_ORIGINS: 'https://black-box.example.test',
      RALLAR_BLACK_BOX_REQUIRE_TLS: '1',
      RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1',
      RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
      RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret',
      RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS: 'api.example.test',
      RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS: 'ws.example.test',
      RALLAR_BLACK_BOX_STORAGE_DIR: '/var/lib/rallar-black-box',
      RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '100',
    }))).toEqual([]);
  });
});

function hardenedApiEnv(): Record<string, string> {
  return {
    RALLAR_PRODUCTION_HARDENING: '1',
    RALLAR_SQL_BACKEND: 'postgres',
    DATABASE_URL: 'postgres://secret-user:secret-pass@db.example.test/rallar',
    CORS_ORIGINS: 'https://app.example.test',
    RALLAR_STATE_STRICT_READ_AUTH: '1',
    AUTH_REGISTRATION_MODE: 'admin',
    AUTH_ADMIN_CLIENT_IDS: 'ops-admin,release-admin',
    AUTH_STATIC_CLIENTS_MODE: 'disabled',
    RALLAR_AUTH_CREDENTIAL_SECRET: 'production-auth-credential-secret-32-chars',
    RALLAR_ICE_MODE: 'metered',
    METERED_APP_NAME: 'rallar-prod',
    METERED_API_KEY: 'metered-secret',
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret',
    RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS: 'ops-admin',
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_TTL_MS: '900000',
  };
}

function env(values: Record<string, string>): Pick<Deno.Env, 'get'> {
  return {
    get(key: string): string | undefined {
      return values[key];
    },
  };
}
