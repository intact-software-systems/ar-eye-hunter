import { expect } from 'bun:test';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';
import { Either } from '@shared/resilience/Either.ts';

const CONTROL_ROOT = new URL('../..', import.meta.url).pathname;

export const ADMIN_TOKEN = 'black-box-admin-token';
export const OPERATOR_TOKEN_SECRET = 'black-box-operator-token-secret';

// Bun.serve binds the wildcard address, so a loopback-only probe would miss a conflict.
const SERVER_BIND_HOST = '0.0.0.0';
const PORT_RANGE_START = 20_000;
// Linux hands out 32768 and above as ephemeral ports, which this suite's own client
// sockets consume while the servers under test are still running.
const PORT_RANGE_END = 32_768;
const PORT_CANDIDATE_ATTEMPTS = 64;
const START_ATTEMPTS = 5;
const ADDRESS_IN_USE = 'AddrInUse';

export interface StartedControlServer {
    readonly baseUrl: string;
    readonly storageDir: string;
    stop(): Promise<void>;
}

let loopbackBindAvailable: Promise<boolean> | undefined;

export function canBindLoopback(): Promise<boolean> {
    loopbackBindAvailable ??= inspectLoopbackAvailability();
    return loopbackBindAvailable;
}

export async function startControlServer(
    env: Readonly<Record<string, string>> = {}
): Promise<StartedControlServer> {
    const storageDir = env.RALLAR_BLACK_BOX_STORAGE_DIR ??
        await mkdtemp(join(tmpdir(), 'rallar-control-api-'));
    let failure = 'No start attempt was made.';
    let attempts = 0;
    while (attempts < START_ATTEMPTS) {
        attempts += 1;
        const started = await startControlServerOnce(env, storageDir);
        if (started.right !== undefined) {
            return started.right;
        }
        failure = started.left ?? failure;
        if (!failure.includes(ADDRESS_IN_USE)) {
            break;
        }
    }
    throw new Error(`Control server did not start. attempts=${attempts}. ${failure}`);
}

export function adminHeaders(): HeadersInit {
    return {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json'
    };
}

export function bearerJsonHeaders(token: string): HeadersInit {
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
    };
}

export async function operatorToken(): Promise<string> {
    const issuedAtEpochMs = Date.now() - 1_000;
    return await signRallarBlackBoxOperatorToken({
        secret: OPERATOR_TOKEN_SECRET,
        subject: 'alice',
        sessionId: 'alice-session',
        issuedAtEpochMs,
        expiresAtEpochMs: issuedAtEpochMs + 60_000,
        tokenId: 'operator-token-id'
    });
}

export async function getJson<TValue>(
    baseUrl: string,
    path: string
): Promise<TValue> {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    return await response.json() as TValue;
}

async function startControlServerOnce(
    env: Readonly<Record<string, string>>,
    storageDir: string
): Promise<Either<string, StartedControlServer>> {
    const port = readBindablePort();
    const child = Bun.spawn({
        cmd: [process.execPath, 'run', 'src/main.ts'],
        cwd: CONTROL_ROOT,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
            RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '0',
            RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS: '20',
            ...env,
            PORT: String(port),
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        }
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForHealth(baseUrl);
    }
    catch (error) {
        const status = await stopChild(child);
        const stderr = await new Response(child.stderr).text().catch(() => '');
        return Either.ofLeft(
            `${error instanceof Error ? error.message : String(error)}\n` +
                `status=${JSON.stringify(status)}\n${stderr}`
        );
    }
    return Either.ofRight({
        baseUrl,
        storageDir,
        async stop() {
            await stopChild(child);
        }
    });
}

export function readBindablePort(): number {
    for (let attempt = 0; attempt < PORT_CANDIDATE_ATTEMPTS; attempt += 1) {
        const port = randomPort();
        if (isPortBindable(port)) {
            return port;
        }
    }
    return randomPort();
}

function isPortBindable(port: number): boolean {
    try {
        listenPort(SERVER_BIND_HOST, port).stop();
        return true;
    }
    catch {
        return false;
    }
}

async function inspectLoopbackAvailability(): Promise<boolean> {
    try {
        listenPort('127.0.0.1', 0).stop();
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('permission') || message.includes('Operation not permitted')) {
            return false;
        }
        throw error;
    }
}

async function waitForHealth(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastErrorMessage = 'No health response received.';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) {
                return;
            }
        }
        catch (error) {
            lastErrorMessage = error instanceof Error ? error.message : String(error);
        }
        await delay(50);
    }
    throw new Error(`Control server did not become healthy: ${lastErrorMessage}`);
}

async function stopChild(
    child: ReturnType<typeof Bun.spawn>
): Promise<number | undefined> {
    child.kill('SIGTERM');
    return await child.exited.catch(() => undefined);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(): number {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return PORT_RANGE_START + (buffer[0] % (PORT_RANGE_END - PORT_RANGE_START));
}

export function listenPort(
    hostname: string,
    port: number
) {
    return Bun.listen({
        hostname,
        port,
        socket: {
            data() {},
            open() {},
            close() {},
            drain() {},
            error() {}
        }
    });
}
