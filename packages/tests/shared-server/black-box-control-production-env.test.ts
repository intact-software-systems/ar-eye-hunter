import {
    collectBlackBoxControlProductionEnvErrors,
    isBlackBoxControlProductionHardeningEnabled
} from '@shared-server/http/black-box-control-production-env.ts';
import { describe, expect, it } from 'vitest';

describe('black-box control production environment validation', () => {
    it('enables hardening only from the explicit black-box process flag', () => {
        expect(isBlackBoxControlProductionHardeningEnabled(env({}))).toBe(false);
        expect(isBlackBoxControlProductionHardeningEnabled(env({
            RALLAR_PRODUCTION_HARDENING: '1'
        }))).toBe(true);
        expect(isBlackBoxControlProductionHardeningEnabled(env({
            ENVIRONMENT: 'production'
        }))).toBe(false);
    });

    it('requires control access and egress guardrails without exposing secret values', () => {
        const errors = collectBlackBoxControlProductionEnvErrors(env({
            RALLAR_PRODUCTION_HARDENING: '1',
            RALLAR_BLACK_BOX_ALLOWED_ORIGINS: '*',
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret'
        }));

        expect(errors.map((error) => error.variable)).toEqual(expect.arrayContaining([
            'RALLAR_BLACK_BOX_ALLOWED_ORIGINS',
            'RALLAR_BLACK_BOX_REQUIRE_TLS',
            'RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN',
            'RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN',
            'RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS',
            'RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS',
            'RALLAR_BLACK_BOX_STORAGE_DIR',
            'RALLAR_BLACK_BOX_RETENTION_MAX_RUNS'
        ]));
        expect(JSON.stringify(errors)).not.toContain('operator-secret');
    });

    it('rejects wildcard HTTPS hostnames', () => {
        expect(
            collectBlackBoxControlProductionEnvErrors(env({
                ...hardenedBlackBoxControlEnvironment(),
                RALLAR_BLACK_BOX_ALLOWED_ORIGINS: 'https://*.example.test'
            })).map((error) => error.variable)
        ).toContain('RALLAR_BLACK_BOX_ALLOWED_ORIGINS');
    });

    it('accepts a hardened black-box control environment', () => {
        expect(collectBlackBoxControlProductionEnvErrors(env(
            hardenedBlackBoxControlEnvironment()
        ))).toEqual([]);
    });
});

function hardenedBlackBoxControlEnvironment(): Record<string, string> {
    return {
        RALLAR_PRODUCTION_HARDENING: '1',
        RALLAR_BLACK_BOX_ALLOWED_ORIGINS: 'https://black-box.example.test',
        RALLAR_BLACK_BOX_REQUIRE_TLS: '1',
        RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1',
        RALLAR_BLACK_BOX_REQUIRE_READ_TOKEN: '1',
        RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-secret',
        RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS: 'api.example.test',
        RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS: 'ws.example.test',
        RALLAR_BLACK_BOX_STORAGE_DIR: '/var/lib/rallar-black-box',
        RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '100'
    };
}

function env(values: Record<string, string>): Pick<Deno.Env, 'get'> {
    return {
        get(key: string): string | undefined {
            return values[key];
        }
    };
}
