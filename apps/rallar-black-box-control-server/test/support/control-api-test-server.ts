import { assertEquals } from '@std/assert';

import { signRallarBlackBoxOperatorToken } from '@shared-server/http/black-box-operator-token.ts';

const CONTROL_ROOT = new URL('../..', import.meta.url).pathname;

export const ADMIN_TOKEN = 'black-box-admin-token';
export const OPERATOR_TOKEN_SECRET = 'black-box-operator-token-secret';

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
        await Deno.makeTempDir({
            prefix: 'rallar-control-api-'
        });
    const port = randomPort();
    const command = new Deno.Command(Deno.execPath(), {
        args: [
            'run',
            '--allow-net',
            '--allow-env',
            '--allow-read',
            '--allow-write',
            'src/main.ts'
        ],
        cwd: CONTROL_ROOT,
        stdin: 'null',
        stdout: 'null',
        stderr: 'piped',
        env: {
            RALLAR_BLACK_BOX_RETENTION_MAX_RUNS: '0',
            ...env,
            PORT: String(port),
            RALLAR_BLACK_BOX_STORAGE_DIR: storageDir
        }
    });
    const child = command.spawn();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForHealth(baseUrl);
    }
    catch (error) {
        const status = await stopChild(child);
        const stderr = await new Response(child.stderr).text().catch(() => '');
        throw new Error(
            `Control server did not start. ${error instanceof Error ? error.message : String(error)}\n` +
                `status=${JSON.stringify(status)}\n${stderr}`
        );
    }
    return {
        baseUrl,
        storageDir,
        async stop() {
            await stopChild(child);
        }
    };
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
    assertEquals(response.status, 200);
    return await response.json() as TValue;
}

async function inspectLoopbackAvailability(): Promise<boolean> {
    try {
        const listener = Deno.listen({
            hostname: '127.0.0.1',
            port: 0
        });
        listener.close();
        return true;
    }
    catch (error) {
        if (error instanceof Deno.errors.PermissionDenied) {
            return false;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Operation not permitted')) {
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
    child: Deno.ChildProcess
): Promise<Deno.CommandStatus | undefined> {
    try {
        child.kill('SIGTERM');
    }
    catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }
    }
    return await child.status.catch(() => undefined);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(): number {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return 20_000 + (buffer[0] % 20_000);
}
