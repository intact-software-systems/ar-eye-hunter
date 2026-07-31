import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
    managedApiDiagnosticSecrets,
    parseApiV1BlackBoxArgs,
    readBoundedLogTail,
    toApiV1BlackBoxEnvironment,
    toClusterRecipeMatrixCommand,
    toRecipeMatrixCommands,
    toManagedApiServerPlans,
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

function secretDiagnosticFixture(): {
    databaseUrl: string;
    secrets: string[];
    text: string;
} {
    const databaseUrl = 'postgres://app:db-password@db.internal/app'
        + '?sslpassword=query-secret&application_name=runner';
    const secrets = [
        databaseUrl,
        'control-token-secret',
        'token-secret',
        'bearer-secret',
        'query-secret',
    ];
    return {
        databaseUrl,
        secrets,
        text: [
            `DATABASE_URL=${databaseUrl}`,
            'Authorization: Bearer bearer-secret',
            'CONTROL_TOKEN=control-token-secret',
            'opaque=control-token-secret',
            'request=https://api.internal/check?token=query-secret&safe=visible',
        ].join('\n'),
    };
}

function expectSecretDiagnosticsRedacted(message: string, secrets: readonly string[]): void {
    for (const secret of secrets) {
        expect(message).not.toContain(secret);
    }
    expect(message).toContain('DATABASE_URL=postgres://app:<redacted>@db.internal/app');
    expect(message).toContain('sslpassword=<redacted>&application_name=runner');
    expect(message).toContain('Authorization: Bearer <redacted>');
    expect(message).toContain('CONTROL_TOKEN=<redacted>');
    expect(message).toContain('opaque=<redacted>');
    expect(message).toContain('token=<redacted>&safe=visible');
}

function responseWithPendingCancellation(status: number): {
    response: Response;
    cancel: ReturnType<typeof vi.fn>;
} {
    const response = new Response('status-only payload', { status });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.spyOn(response.body!, 'cancel').mockImplementation(cancel);
    return { response, cancel };
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
    it('starts two API servers for the local Postgres black-box command', async () => {
        const packageJson = JSON.parse(await readFile(
            path.join(repoRoot, 'packages/shared-test/package.json'),
            'utf8',
        )) as { scripts?: Record<string, string> };

        expect(packageJson.scripts?.['bb:api-v1:postgres']).toContain(
            '--secondary-port=18081',
        );
    });

    it('defaults to Postgres on port 18080', () => {
        const options = parseApiV1BlackBoxArgs([]);

        expect(options).toMatchObject({
            backend: 'postgres',
            port: 18080,
            profile: 'api-v1-black-box',
            artifactDir: '.artifacts/api-v1-black-box/postgres',
            requireGates: true,
            runMigrations: true,
            recipesOnly: false,
        });
        expect(options).not.toHaveProperty('secondaryPort');
    });

    it('accepts a distinct secondary Postgres API port', () => {
        expect(parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--port=18080',
            '--secondary-port=18081',
        ])).toMatchObject({
            backend: 'postgres',
            port: 18080,
            secondaryPort: 18081,
        });
    });

    it('selects the opt-in medium-scale cluster profile without the ordinary profile', () => {
        expect(parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--cluster-only',
            '--cluster-profile=api-v1-black-box-medium-scale',
        ])).toMatchObject({
            backend: 'postgres',
            secondaryPort: 18081,
            clusterOnly: true,
            clusterProfile: 'api-v1-black-box-medium-scale',
        });

        expect(() => parseApiV1BlackBoxArgs(['--cluster-only']))
            .toThrow(/cluster-only.*secondary-port/i);
    });

    it.each([
        ['same as the primary port', ['--port=18080', '--secondary-port=18080']],
        ['outside the port range', ['--secondary-port=65536']],
        ['with pglite-memory', ['--backend=pglite-memory', '--secondary-port=18081']],
        ['in recipes-only mode', ['--recipes-only', '--secondary-port=18081']],
    ])('rejects a secondary API port %s', (_label, args) => {
        expect(() => parseApiV1BlackBoxArgs(args)).toThrow(/secondary/i);
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
        expect(env.RALLAR_LOGIN_IP_RATE_LIMIT).toBe('100');
        expect(env.RALLAR_LOGIN_USER_RATE_LIMIT).toBe('100');
        expect(env.RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET).toBe(
            'local-api-v1-black-box-operator-secret',
        );
        expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
        expect(env.AUTH_REGISTRATION_MODE).toBe('public');
        expect(env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON).toBe(
            '[{"documentType":"black-box-map","rollout":"production"}]',
        );
    });

    it('preserves an explicit managed API CRDT document policy', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=pglite-memory']);
        const policy = '[{"documentType":"custom-map","rollout":"development"}]';
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON: policy,
        });

        expect(env.RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON).toBe(policy);
    });

    it('preserves explicit managed API login rate limits', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_LOGIN_IP_RATE_LIMIT: '41',
            RALLAR_LOGIN_USER_RATE_LIMIT: '17',
        });

        expect(env.RALLAR_LOGIN_IP_RATE_LIMIT).toBe('41');
        expect(env.RALLAR_LOGIN_USER_RATE_LIMIT).toBe('17');
    });

    it('exposes secondary HTTP and WebSocket URLs only for a two-server run', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--port=18080',
            '--secondary-port=18081',
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:18080');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:18080');
        expect(env.RALLAR_API_BASE_URL_SECONDARY).toBe(
            'http://127.0.0.1:18081',
        );
        expect(env.RALLAR_WS_BASE_URL_SECONDARY).toBe(
            'ws://127.0.0.1:18081',
        );
    });

    it('plans isolated process URLs and log files for both managed servers', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--port=18080',
            '--secondary-port=18081',
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(toManagedApiServerPlans(options, env, '/tmp/api-v1-bb')).toEqual([
            expect.objectContaining({
                port: 18080,
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-bb/api-v1-server.log',
                env: expect.objectContaining({
                    PORT: '18080',
                    RALLAR_API_BASE_URL: 'http://127.0.0.1:18080',
                    RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18080',
                }),
            }),
            expect.objectContaining({
                port: 18081,
                baseUrl: 'http://127.0.0.1:18081',
                logPath: '/tmp/api-v1-bb/api-v1-server-secondary.log',
                env: expect.objectContaining({
                    PORT: '18081',
                    RALLAR_API_BASE_URL: 'http://127.0.0.1:18081',
                    RALLAR_WS_BASE_URL: 'ws://127.0.0.1:18081',
                }),
            }),
        ]);
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

    it('runs every two-server cluster recipe through the cluster profile', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
        ]);

        expect(toClusterRecipeMatrixCommand(options, '/tmp/api-v1-bb')).toEqual([
            'deno',
            'run',
            '-A',
            'packages/shared-test/black-box-runner/recipe-matrix.mts',
            '--profile=api-v1-black-box-cluster',
            '--require-gates',
            '--artifact-dir=/tmp/api-v1-bb/cluster',
        ]);
    });

    it('plans only the selected cluster profile under the cluster artifact directory', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
            '--cluster-only',
            '--cluster-profile=api-v1-black-box-medium-scale',
        ]);

        expect(toRecipeMatrixCommands(options, '/tmp/api-v1-bb')).toEqual([
            [
                'deno',
                'run',
                '-A',
                'packages/shared-test/black-box-runner/recipe-matrix.mts',
                '--profile=api-v1-black-box-medium-scale',
                '--require-gates',
                '--artifact-dir=/tmp/api-v1-bb/cluster',
            ],
        ]);
    });

    it('preserves the ordinary profile before the default two-server cluster profile', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=postgres',
            '--secondary-port=18081',
        ]);

        expect(toRecipeMatrixCommands(options, '/tmp/api-v1-bb').map(command =>
            command.find(argument => argument.startsWith('--profile='))
        )).toEqual([
            '--profile=api-v1-black-box',
            '--profile=api-v1-black-box-cluster',
        ]);
    });

    it('reads only the fixed-size suffix of a large production log tail', async () => {
        const bytes = new TextEncoder().encode('x'.repeat(16_384) + 'useful-tail');
        const reads: Array<{ offset: number; length: number }> = [];
        const close = vi.fn();

        const tail = await readBoundedLogTail('/large/api-v1.log', {
            openFile: async (_path: string) => ({
                size: async () => bytes.byteLength,
                readAt: async (offset: number, target: Uint8Array) => {
                    reads.push({ offset, length: target.byteLength });
                    const source = bytes.subarray(offset, offset + target.byteLength);
                    target.set(source);
                    return source.byteLength;
                },
                close,
            }),
        });

        expect(reads).toEqual([{
            offset: bytes.byteLength - 4096,
            length: 4096,
        }]);
        expect(tail.endsWith('useful-tail')).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it('continues partial bounded reads with advancing offsets and shrinking targets', async () => {
        const bytes = new TextEncoder().encode('x'.repeat(16_384) + 'useful-tail');
        const reads: Array<{ offset: number; length: number }> = [];
        const close = vi.fn();
        const firstOffset = bytes.byteLength - 4096;

        const tail = await readBoundedLogTail('/partial/api-v1.log', {
            openFile: async () => ({
                size: async () => bytes.byteLength,
                readAt: async (offset: number, target: Uint8Array) => {
                    reads.push({ offset, length: target.byteLength });
                    const length = Math.min(1024, target.byteLength);
                    target.set(bytes.subarray(offset, offset + length));
                    return length;
                },
                close,
            }),
        });

        expect(reads).toEqual([
            { offset: firstOffset, length: 4096 },
            { offset: firstOffset + 1024, length: 3072 },
            { offset: firstOffset + 2048, length: 2048 },
            { offset: firstOffset + 3072, length: 1024 },
        ]);
        expect(tail.endsWith('useful-tail')).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it('tolerates a UTF-8 suffix starting inside a multibyte code point', async () => {
        const bytes = new Uint8Array(4098).fill('x'.charCodeAt(0));
        bytes.set([0xe2, 0x82, 0xac], 0);
        const suffix = new TextEncoder().encode('useful-tail');
        bytes.set(suffix, bytes.byteLength - suffix.byteLength);
        const close = vi.fn();

        const tail = await readBoundedLogTail('/utf8/api-v1.log', {
            openFile: async () => ({
                size: async () => bytes.byteLength,
                readAt: async (offset: number, target: Uint8Array) => {
                    const source = bytes.subarray(offset, offset + target.byteLength);
                    target.set(source);
                    return source.byteLength;
                },
                close,
            }),
        });

        expect(tail.startsWith('\ufffd')).toBe(true);
        expect(tail.endsWith('useful-tail')).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    it.each(['size', 'readAt'] as const)('closes the bounded tail file after %s failure', async failure => {
        const close = vi.fn();

        const tail = await readBoundedLogTail(`/failure/${failure}.log`, {
            openFile: async () => ({
                size: async () => {
                    if (failure === 'size') {
                        throw new Error('size failed');
                    }
                    return 64;
                },
                readAt: async () => {
                    throw new Error('readAt failed');
                },
                close,
            }),
        });

        expect(tail).toContain(`unable to read /failure/${failure}.log`);
        expect(close).toHaveBeenCalledOnce();
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

    it('normalizes a string child-status rejection at the readiness boundary', async () => {
        const outcome = await observeReadiness(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: Promise.reject('child-status-string'),
            startup: new Promise<void>(() => undefined),
            streamsDrained: Promise.resolve(),
            readTextFile: async () => 'unused',
            timeoutMs: 1_000,
        }));

        expect(outcome).toEqual({ ok: false, error: new Error('child-status-string') });
    });

    it('normalizes an object startup rejection at the readiness boundary', async () => {
        const outcome = await observeReadiness(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: new Promise(() => undefined),
            startup: Promise.reject({ kind: 'startup-object' }),
            streamsDrained: Promise.resolve(),
            readTextFile: async () => 'unused',
            timeoutMs: 1_000,
        }));

        expect(outcome).toEqual({ ok: false, error: new Error('[object Object]') });
    });

    it('normalizes an AbortSignal reason at the readiness boundary', async () => {
        const controller = new AbortController();
        controller.abort('startup-abort-reason');
        const outcome = await observeReadiness(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: new Promise(() => undefined),
            startup: Promise.reject(controller.signal.reason),
            streamsDrained: Promise.resolve(),
            readTextFile: async () => 'unused',
            timeoutMs: 1_000,
        }));

        expect(outcome).toEqual({ ok: false, error: new Error('startup-abort-reason') });
    });

    for (const rejection of [
        { name: 'null', value: null },
        { name: 'undefined', value: undefined },
    ] as const) {
        it(`keeps a ${rejection.name} fetch rejection as an absent timeout error`, async () => {
            vi.useFakeTimers();
            try {
                let attempt = 0;
                const outcomePromise = observeReadiness(waitForManagedApiReady({
                    baseUrl: 'http://127.0.0.1:18080',
                    logPath: '/tmp/api-v1-server.log',
                    childStatus: new Promise(() => undefined),
                    startup: Promise.resolve(),
                    streamsDrained: Promise.resolve(),
                    fetchImpl: () => {
                        attempt += 1;
                        if (attempt === 1) return Promise.resolve(new Response(null, { status: 503 }));
                        if (attempt === 2) return Promise.reject(rejection.value);
                        return new Promise(() => undefined);
                    },
                    readTextFile: async () => 'Server started on port 18080.',
                    sleep: async () => undefined,
                    timeoutMs: 100,
                }));

                await vi.advanceTimersByTimeAsync(100);
                const outcome = await outcomePromise;

                expect(outcome).toEqual({
                    ok: false,
                    error: new Error(
                        'Timed out waiting for http://127.0.0.1:18080/api/config: ' +
                            'no successful response\nLatest API-v1 log tail:\n' +
                            'Server started on port 18080.',
                    ),
                });
                expect(attempt).toBe(3);
            } finally {
                vi.useRealTimers();
            }
        });
    }

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

    it('cancels a successful config response body without masking readiness', async () => {
        const response = new Response('status-only payload', { status: 200 });
        const cancel = vi.spyOn(response.body!, 'cancel')
            .mockRejectedValueOnce(new Error('body cancel failed'));

        await expect(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: new Promise(() => undefined),
            startup: Promise.resolve(),
            streamsDrained: Promise.resolve(),
            fetchImpl: async () => response,
            readTextFile: async () => 'unused',
            timeoutMs: 1_000,
        })).resolves.toBeUndefined();

        expect(cancel).toHaveBeenCalledOnce();
    });

    it('does not wait for a never-settling successful response cancellation', async () => {
        vi.useFakeTimers();
        try {
            const { response, cancel } = responseWithPendingCancellation(200);
            const outcomePromise = observeReadiness(waitForManagedApiReady({
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-server.log',
                childStatus: new Promise(() => undefined),
                startup: Promise.resolve(),
                streamsDrained: Promise.resolve(),
                fetchImpl: async () => response,
                readTextFile: async () => 'unused',
                timeoutMs: 100,
            }));
            let settled = false;
            void outcomePromise.then(() => {
                settled = true;
            });

            for (let index = 0; index < 50 && !settled; index += 1) {
                await Promise.resolve();
            }
            const settledPromptly = settled;
            if (!settled) {
                await vi.advanceTimersByTimeAsync(100);
            }
            const outcome = await outcomePromise;

            expect(settledPromptly).toBe(true);
            expect(outcome.ok).toBe(true);
            expect(cancel).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries without waiting for never-settling response cancellations', async () => {
        vi.useFakeTimers();
        try {
            const retry = responseWithPendingCancellation(503);
            const success = responseWithPendingCancellation(200);
            let attempt = 0;
            const fetchImpl = vi.fn(async () => {
                attempt += 1;
                return attempt === 1 ? retry.response : success.response;
            });
            const outcomePromise = observeReadiness(waitForManagedApiReady({
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-server.log',
                childStatus: new Promise(() => undefined),
                startup: Promise.resolve(),
                streamsDrained: Promise.resolve(),
                fetchImpl,
                readTextFile: async () => 'unused',
                sleep: async () => undefined,
                timeoutMs: 100,
            }));
            let settled = false;
            void outcomePromise.then(() => {
                settled = true;
            });

            for (let index = 0; index < 50 && !settled; index += 1) {
                await Promise.resolve();
            }
            const settledPromptly = settled;
            if (!settled) {
                await vi.advanceTimersByTimeAsync(100);
            }
            const outcome = await outcomePromise;

            expect(settledPromptly).toBe(true);
            expect(outcome.ok).toBe(true);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
            expect(retry.cancel).toHaveBeenCalledOnce();
            expect(success.cancel).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries a non-OK config response after startup', async () => {
        const fetchSignalStates: boolean[] = [];
        const retryResponse = new Response('retry payload', { status: 503 });
        const successResponse = new Response('success payload', { status: 200 });
        const cancelRetry = vi.spyOn(retryResponse.body!, 'cancel')
            .mockRejectedValueOnce(new Error('retry body cancel failed'));
        const cancelSuccess = vi.spyOn(successResponse.body!, 'cancel');
        let attempt = 0;
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            fetchSignalStates.push(init?.signal?.aborted ?? false);
            attempt += 1;
            return attempt === 1 ? retryResponse : successResponse;
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
        expect(cancelRetry).toHaveBeenCalledOnce();
        expect(cancelSuccess).toHaveBeenCalledOnce();
    });

    it('redacts secrets from child-exit diagnostics', async () => {
        const fixture = secretDiagnosticFixture();
        const outcome = await observeReadiness(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: Promise.resolve({ success: false, code: 1, signal: null }),
            startup: new Promise<void>(() => undefined),
            streamsDrained: Promise.resolve(),
            fetchImpl: async () => new Response(null, { status: 200 }),
            readTextFile: async () => fixture.text,
            diagnosticSecrets: fixture.secrets,
            timeoutMs: 1_000,
        }));

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expectSecretDiagnosticsRedacted(String(outcome.error), fixture.secrets);
        }
    });

    it('redacts secrets from timeout diagnostics', async () => {
        vi.useFakeTimers();
        try {
            const fixture = secretDiagnosticFixture();
            const outcomePromise = observeReadiness(waitForManagedApiReady({
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-server.log',
                childStatus: new Promise(() => undefined),
                startup: new Promise<void>(() => undefined),
                streamsDrained: Promise.resolve(),
                fetchImpl: async () => new Response(null, { status: 200 }),
                readTextFile: async () => fixture.text,
                diagnosticSecrets: fixture.secrets,
                timeoutMs: 100,
            }));

            await vi.advanceTimersByTimeAsync(100);
            const outcome = await outcomePromise;

            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expectSecretDiagnosticsRedacted(String(outcome.error), fixture.secrets);
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('redacts production-derived METERED_API_KEY in child and timeout diagnostics', async () => {
        const meteredApiKey = 'metered-api-key-value';
        const accessKey = 'access-key-value';
        const privateKey = 'private-key-value';
        const credential = 'credential-value';
        const diagnosticSecrets = managedApiDiagnosticSecrets({
            METERED_API_KEY: meteredApiKey,
            AWS_ACCESS_KEY_ID: accessKey,
            SIGNING_PRIVATE_KEY: privateKey,
            CLIENT_CREDENTIAL: credential,
            PUBLIC_KEY_ID: 'public-key-id',
            KEYBOARD_LAYOUT: 'us',
            MONKEY_PATCH: 'enabled',
        });

        expect(diagnosticSecrets).toEqual(expect.arrayContaining([
            meteredApiKey,
            accessKey,
            privateKey,
            credential,
        ]));
        expect(diagnosticSecrets).not.toEqual(expect.arrayContaining([
            'public-key-id',
            'us',
            'enabled',
        ]));

        const logTail = `opaque=${meteredApiKey}`;
        const childOutcome = await observeReadiness(waitForManagedApiReady({
            baseUrl: 'http://127.0.0.1:18080',
            logPath: '/tmp/api-v1-server.log',
            childStatus: Promise.resolve({ success: false, code: 1, signal: null }),
            startup: new Promise<void>(() => undefined),
            streamsDrained: Promise.resolve(),
            fetchImpl: async () => new Response(null, { status: 200 }),
            readTextFile: async () => logTail,
            diagnosticSecrets,
            timeoutMs: 100,
        }));
        expect(childOutcome.ok).toBe(false);
        if (!childOutcome.ok) {
            expect(String(childOutcome.error)).not.toContain(meteredApiKey);
            expect(String(childOutcome.error)).toContain('opaque=<redacted>');
        }

        vi.useFakeTimers();
        try {
            const timeoutOutcomePromise = observeReadiness(waitForManagedApiReady({
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-server.log',
                childStatus: new Promise(() => undefined),
                startup: new Promise<void>(() => undefined),
                streamsDrained: Promise.resolve(),
                fetchImpl: async () => new Response(null, { status: 200 }),
                readTextFile: async () => logTail,
                diagnosticSecrets,
                timeoutMs: 100,
            }));
            await vi.advanceTimersByTimeAsync(100);
            const timeoutOutcome = await timeoutOutcomePromise;

            expect(timeoutOutcome.ok).toBe(false);
            if (!timeoutOutcome.ok) {
                expect(String(timeoutOutcome.error)).not.toContain(meteredApiKey);
                expect(String(timeoutOutcome.error)).toContain('opaque=<redacted>');
            }
        } finally {
            vi.useRealTimers();
        }
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
                fetchSignal = init?.signal ?? undefined;
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
                    fetchSignal = init?.signal ?? undefined;
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

    it('cancels a late config response body after timeout without leaking cancel failure', async () => {
        vi.useFakeTimers();
        try {
            const fetchResponse = deferred<Response>();
            const observeCancellation = vi.fn();
            const cancellation = { then: observeCancellation } as unknown as Promise<void>;
            const cancel = vi.fn(() => cancellation);
            const response = {
                ok: true,
                status: 200,
                body: { cancel },
            } as unknown as Response;
            const outcomePromise = observeReadiness(waitForManagedApiReady({
                baseUrl: 'http://127.0.0.1:18080',
                logPath: '/tmp/api-v1-server.log',
                childStatus: new Promise(() => undefined),
                startup: Promise.resolve(),
                streamsDrained: Promise.resolve(),
                fetchImpl: async () => await fetchResponse.promise,
                readTextFile: async () => 'timeout diagnostics',
                timeoutMs: 100,
            }));

            await flushMicrotasks();
            await vi.advanceTimersByTimeAsync(100);
            expect((await outcomePromise).ok).toBe(false);

            fetchResponse.resolve(response);
            await flushMicrotasks();
            const cancellationWasObserved = observeCancellation.mock.calls.length > 0;
            expect(cancel).toHaveBeenCalledOnce();
            expect(cancellationWasObserved).toBe(true);
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
