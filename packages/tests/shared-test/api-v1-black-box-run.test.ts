import { describe, expect, it } from 'vitest';
import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand,
} from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('api-v1 black-box run helper', () => {
    it('defaults to Postgres on port 18080', () => {
        expect(parseApiV1BlackBoxArgs([])).toMatchObject({
            backend: 'postgres',
            port: 18080,
            profile: 'api-v1-black-box',
            artifactDir: '.artifacts/api-v1-black-box/postgres',
            requireGates: true,
            runMigrations: true,
            recipesOnly: false,
        });
    });

    it('keeps recipes-only mode free of server and migration side effects', () => {
        expect(parseApiV1BlackBoxArgs(['--recipes-only'])).toMatchObject({
            backend: 'postgres',
            profile: 'api-v1-black-box-recipes',
            requireGates: true,
            runMigrations: false,
            recipesOnly: true,
        });
    });

    it('allows recipes-only mode to opt into the full managed API-v1 profile', () => {
        expect(parseApiV1BlackBoxArgs([
            '--recipes-only',
            '--profile=api-v1-black-box',
        ])).toMatchObject({
            profile: 'api-v1-black-box',
            recipesOnly: true,
        });
    });

    it('builds Postgres server environment with a local DATABASE_URL default', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres', '--port=18080']);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(env.PORT).toBe('18080');
        expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
        expect(env.DATABASE_URL).toBe('postgres://app:app@localhost:5432/appdb');
        expect(env.RALLAR_STATE_STRICT_READ_AUTH).toBe('1');
        expect(env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe(
            'local-api-v1-black-box-operator-secret',
        );
        expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
        expect(env.AUTH_REGISTRATION_MODE).toBe('public');
    });

    it('preserves explicit black-box operator token secret values', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'custom-operator-secret',
        });

        expect(env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe('custom-operator-secret');
    });

    it('preserves explicit Postgres DATABASE_URL values', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            DATABASE_URL: 'postgres://custom:custom@localhost:15432/customdb',
        });

        expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
        expect(env.DATABASE_URL).toBe('postgres://custom:custom@localhost:15432/customdb');
    });

    it('preserves explicit API URLs in recipes-only mode', () => {
        const options = parseApiV1BlackBoxArgs(['--recipes-only']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_API_BASE_URL: 'http://127.0.0.1:19999',
            RALLAR_WS_BASE_URL: 'ws://127.0.0.1:19999',
        });

        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19999');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19999');
    });

    it('builds pglite-memory server environment without Postgres settings', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=pglite-memory',
            '--port=19090',
            '--run-id=local-123',
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(env.PORT).toBe('19090');
        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19090');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19090');
        expect(env.RALLAR_BB_RUN_ID).toBe('local-123');
        expect(env.RALLAR_SQL_BACKEND).toBe('pglite-memory');
        expect(env.RALLAR_PGLITE_DATA_DIR).toBe('memory://');
        expect(env.RALLAR_PGLITE_SCHEMA_INIT).toBe('auto');
        expect(env.RALLAR_DB_PUBSUB).toBe('local');
        expect(env.RALLAR_STATE_STRICT_READ_AUTH).toBe('1');
        expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
        expect(env.AUTH_REGISTRATION_MODE).toBe('public');
    });

    it('builds the api-v1 Deno server command', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);

        expect(toApiV1ServerCommand(options)).toEqual([
            'deno',
            'run',
            '--config',
            'apps/api-v1/deno.json',
            '--allow-net',
            '--allow-env',
            '--allow-read',
            'apps/api-v1/src/main.ts',
        ]);
    });
});
