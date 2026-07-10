import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand,
    waitForManagedApiReady,
} from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const managedRunnerPath = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/api-v1-black-box-run.mts',
);

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function runManagedApiRunner(port: number, artifactDir: string): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn('deno', [
            'run',
            '-A',
            managedRunnerPath,
            '--backend=pglite-memory',
            `--port=${port}`,
            '--profile=remote-dry',
            `--artifact-dir=${artifactDir}`,
        ], {
            cwd: repoRoot,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }));
    });
}

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

    it('rejects when the managed API child exits while another listener is ready', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        const readiness = waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: Promise.resolve({ success: false, code: 1, signal: null }),
            fetchImpl,
            readTextFile: async () => 'AddrInUse',
            now: () => 0,
            sleep: async () => undefined,
        });

        await expect(readiness).rejects.toThrow('API-v1 child exited before readiness (code 1)');
        await expect(readiness).rejects.toThrow('AddrInUse');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects an unrelated config listener on the managed API port', async () => {
        let configRequests = 0;
        const listener = createServer((request, response) => {
            if (request.url === '/api/config') {
                configRequests += 1;
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end('{}');
                return;
            }
            response.writeHead(404);
            response.end();
        });
        await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '0.0.0.0', () => {
                listener.off('error', reject);
                resolve();
            });
        });

        const address = listener.address();
        if (!address || typeof address === 'string') {
            await closeServer(listener);
            throw new Error('Occupied-port listener did not expose a TCP address.');
        }
        const artifactDir = await mkdtemp(path.join(tmpdir(), 'api-v1-managed-readiness-'));

        try {
            const result = await runManagedApiRunner(address.port, artifactDir);

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('API-v1 child exited before readiness');
            expect(result.stdout).not.toContain('Matrix profile remote-dry:');
            expect(configRequests).toBe(0);
        } finally {
            await closeServer(listener);
            await rm(artifactDir, { recursive: true, force: true });
        }
    }, 30_000);
});
