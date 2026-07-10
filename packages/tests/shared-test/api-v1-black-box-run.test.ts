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

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
    }
}

function observeReadiness(promise: Promise<void>): Promise<
    { ok: true } | { ok: false; error: unknown }
> {
    return promise.then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error }),
    );
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

async function runManagedApiRunner(port: number, artifactDir: string, timeoutMs = 10_000): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}> {
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
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const childExit = new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
            child.once('error', reject);
            child.once('close', code => resolve({ code: code ?? 0, stdout, stderr }));
        },
    );
    const hardTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error(`Managed API runner did not exit within ${timeoutMs}ms.`));
        }, timeoutMs);
    });

    try {
        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        return await Promise.race([childExit, hardTimeout]);
    } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        await childExit.catch(() => undefined);
        throw error;
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
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
            startup: new Promise<void>(() => undefined),
            streamsDrained: Promise.resolve(),
            fetchImpl,
            readTextFile: async () => 'AddrInUse',
            now: () => 0,
            sleep: async () => undefined,
        });

        await expect(readiness).rejects.toThrow('API-v1 child exited before readiness (code 1)');
        await expect(readiness).rejects.toThrow('AddrInUse');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('waits for the child startup marker before accepting config', async () => {
        const startup = deferred<void>();
        const fetchSignals: AbortSignal[] = [];
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.signal) {
                fetchSignals.push(init.signal);
            }
            return new Response(null, { status: 200 });
        });
        const readiness = waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: new Promise(() => undefined),
            startup: startup.promise,
            streamsDrained: Promise.resolve(),
            fetchImpl,
            readTextFile: async () => 'Server started on port 18080.',
            timeoutMs: 1_000,
        });

        await flushMicrotasks();
        const fetchesBeforeStartup = fetchImpl.mock.calls.length;
        startup.resolve();
        await expect(readiness).resolves.toBeUndefined();

        expect(fetchesBeforeStartup).toBe(0);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchSignals).toHaveLength(1);
        expect(fetchSignals[0].aborted).toBe(true);
    });

    it('retries a non-OK config response after startup', async () => {
        const fetchSignalStates: boolean[] = [];
        let attempt = 0;
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            fetchSignalStates.push(init?.signal.aborted ?? false);
            attempt += 1;
            return new Response(null, { status: attempt === 1 ? 503 : 200 });
        });
        const sleepImpl = vi.fn(async (_ms: number, signal?: AbortSignal) => {
            expect(signal?.aborted).toBe(false);
        });

        await expect(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: new Promise(() => undefined),
            startup: Promise.resolve(),
            streamsDrained: Promise.resolve(),
            fetchImpl,
            readTextFile: async () => 'Server started on port 18080.',
            sleep: sleepImpl,
            timeoutMs: 1_000,
        })).resolves.toBeUndefined();

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleepImpl).toHaveBeenCalledTimes(1);
        expect(fetchSignalStates).toEqual([false, false]);
    });

    it('aborts an in-flight fetch and drains streams before reporting child exit', async () => {
        const childStatus = deferred<{ success: boolean; code: number; signal: string | null }>();
        const streamsDrained = deferred<void>();
        const fetchResponse = deferred<Response>();
        let fetchSignal: AbortSignal | undefined;
        const readiness = waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: childStatus.promise,
            startup: Promise.resolve(),
            streamsDrained: streamsDrained.promise,
            fetchImpl: async (_url: string, init?: RequestInit) => {
                fetchSignal = init?.signal;
                return await fetchResponse.promise;
            },
            readTextFile: async () => 'AddrInUse: Address already in use',
            timeoutMs: 1_000,
        });
        const outcomePromise = observeReadiness(readiness);
        let settled = false;
        void outcomePromise.then(() => {
            settled = true;
        });

        await flushMicrotasks();
        childStatus.resolve({ success: false, code: 1, signal: null });
        await flushMicrotasks();
        const settledBeforeDrain = settled;
        const fetchWasAborted = fetchSignal?.aborted ?? false;
        streamsDrained.resolve();
        fetchResponse.resolve(new Response(null, { status: 200 }));
        const outcome = await outcomePromise;

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.error).toEqual(expect.objectContaining({
                message: expect.stringContaining('API-v1 child exited before readiness (code 1)'),
            }));
        }
        expect(settledBeforeDrain).toBe(false);
        expect(fetchWasAborted).toBe(true);
    });

    it('hard-times out an in-flight fetch and rejects a late OK response', async () => {
        vi.useFakeTimers();
        try {
            const fetchResponse = deferred<Response>();
            let fetchSignal: AbortSignal | undefined;
            const readiness = waitForManagedApiReady({
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-server.log',
                childStatus: new Promise(() => undefined),
                startup: Promise.resolve(),
                streamsDrained: Promise.resolve(),
                fetchImpl: async (_url: string, init?: RequestInit) => {
                    fetchSignal = init?.signal;
                    return await fetchResponse.promise;
                },
                readTextFile: async () => 'Server started on port 18080.',
                timeoutMs: 100,
            });
            const outcomePromise = observeReadiness(readiness);

            await flushMicrotasks();
            await vi.advanceTimersByTimeAsync(100);
            const fetchWasAborted = fetchSignal?.aborted ?? false;
            fetchResponse.resolve(new Response(null, { status: 200 }));
            const outcome = await outcomePromise;

            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.error).toEqual(expect.objectContaining({
                    message: expect.stringContaining(
                        'Timed out waiting for http://127.0.0.1:18080/api/config',
                    ),
                }));
            }
            expect(fetchWasAborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts the losing retry sleep when the child exits', async () => {
        const childStatus = deferred<{ success: boolean; code: number; signal: string | null }>();
        let sleepSignal: AbortSignal | undefined;
        let sleepAborted = false;
        const sleepImpl = vi.fn((_ms: number, signal?: AbortSignal) => {
            sleepSignal = signal;
            if (!signal) {
                return new Promise<void>(() => undefined);
            }
            return new Promise<void>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    sleepAborted = true;
                    reject(signal.reason);
                }, { once: true });
            });
        });
        const readiness = waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: childStatus.promise,
            startup: Promise.resolve(),
            streamsDrained: Promise.resolve(),
            fetchImpl: async () => new Response(null, { status: 503 }),
            readTextFile: async () => 'AddrInUse',
            sleep: sleepImpl,
            timeoutMs: 1_000,
        });
        const outcomePromise = observeReadiness(readiness);

        await flushMicrotasks();
        childStatus.resolve({ success: false, code: 1, signal: null });
        const outcome = await outcomePromise;

        expect(outcome.ok).toBe(false);
        expect(sleepImpl).toHaveBeenCalledTimes(1);
        expect(sleepSignal?.aborted).toBe(true);
        expect(sleepAborted).toBe(true);
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
            expect(result.stderr).toContain('AddrInUse');
            expect(result.stdout).not.toContain('Matrix profile remote-dry:');
            expect(configRequests).toBe(0);
        } finally {
            await closeServer(listener);
            await rm(artifactDir, { recursive: true, force: true });
        }
    }, 30_000);
});
