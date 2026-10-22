import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

const repoRoot = path.resolve(__dirname, '../../..');

async function runHeadlessWorker(
    env: NodeJS.ProcessEnv
): Promise<Readonly<{ exitCode: number | null; output: string; }>> {
    return await startHeadlessWorker(env).result;
}

function startHeadlessWorker(env: NodeJS.ProcessEnv) {
    const worker = spawn(
        path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
        ['apps/rallar-black-box/scripts/headless-worker.ts'],
        { cwd: repoRoot, env }
    );
    let output = '';
    const appendOutput = (chunk: Buffer) => {
        output += String(chunk);
    };
    worker.stdout.on('data', appendOutput);
    worker.stderr.on('data', appendOutput);
    const result = new Promise<
        Readonly<{
            exitCode: number | null;
            output: string;
        }>
    >((resolve, reject) => {
        worker.once('error', reject);
        worker.once('close', (exitCode) => resolve({ exitCode, output }));
    });

    return { worker, result, getOutput: () => output };
}

/** Matches the output accumulated since spawn, so text written before the wait or split across chunks is found. */
function waitForOutput(runningWorker: ReturnType<typeof startHeadlessWorker>, text: string): Promise<void> {
    return new Promise<void>((resolve) => {
        const onData = () => {
            if (runningWorker.getOutput().includes(text)) {
                runningWorker.worker.stdout.removeListener('data', onData);
                resolve();
            }
        };
        runningWorker.worker.stdout.on('data', onData);
        onData();
    });
}

async function listenOnLoopback(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return address.port;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) {
        return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

interface HeldReadAgent {
    readonly spaServer: Server;
    readonly controlServer: Server;
    readonly readServer: WebSocketServer;
    /** The close code and reason the held read's server side received. */
    readonly readClosed: Promise<Readonly<{ code: number; reason: string; }>>;
    readonly readOpened: Promise<void>;
}

const HELD_READ_RUN_ID = 'run-held-read-teardown';
const HELD_READ_AGENT_ID = 'held-agent-01';
const ORDERLY_CLOSE_CODE = 1000;

/**
 * An agent page that holds a live WebSocket read and exposes the page runtime's `close`, which the
 * worker owns calling before the browser context goes away.
 */
function toHeldReadAgentPage(readUrl: string, closeBody: string): string {
    return `<!doctype html><html><body>
<div data-headless-agent-root><span data-agent-id>${HELD_READ_AGENT_ID}</span></div>
<script>
const socket = new WebSocket(${JSON.stringify(readUrl)});
const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
window.__blackBoxRallar = { close: async () => { ${closeBody} } };
</script></body></html>`;
}

async function startHeldReadAgent(closeBody: string): Promise<HeldReadAgent> {
    const readServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => readServer.once('listening', () => resolve()));
    const readUrl = `ws://127.0.0.1:${(readServer.address() as AddressInfo).port}/held-read`;
    const readOpened = new Promise<void>((resolve) => readServer.once('connection', () => resolve()));
    const readClosed = new Promise<Readonly<{ code: number; reason: string; }>>((resolve) => {
        readServer.once('connection', (socket) => {
            socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        });
    });
    const spaServer = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(toHeldReadAgentPage(readUrl, closeBody));
    });
    const controlServer = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ agents: [{ agentId: HELD_READ_AGENT_ID, connected: true, status: 'idle' }] }));
    });
    await listenOnLoopback(spaServer);
    await listenOnLoopback(controlServer);
    return { spaServer, controlServer, readServer, readClosed, readOpened };
}

function toHeldReadWorkerEnv(agent: HeldReadAgent, pageDisconnectTimeoutMs: number): NodeJS.ProcessEnv {
    const spaUrl = `http://127.0.0.1:${(agent.spaServer.address() as AddressInfo).port}`;
    const controlUrl = `http://127.0.0.1:${(agent.controlServer.address() as AddressInfo).port}`;
    return {
        ...process.env,
        RALLAR_BLACK_BOX_SPA_URL: spaUrl,
        RALLAR_BLACK_BOX_CONTROL_URL: controlUrl,
        RALLAR_CONTROL_HTTP_URL: controlUrl,
        RALLAR_API_BASE_URL: `${spaUrl}/api`,
        RALLAR_BLACK_BOX_RUN_ID: HELD_READ_RUN_ID,
        RALLAR_BLACK_BOX_ROOM_ID: 'room-held-read-teardown',
        RALLAR_BLACK_BOX_AGENT_COUNT: '1',
        RALLAR_BLACK_BOX_AGENT_START_INDEX: '1',
        RALLAR_BLACK_BOX_AGENT_PREFIX: 'held-agent',
        RALLAR_BLACK_BOX_USERNAME: 'operator',
        RALLAR_BLACK_BOX_PASSWORD: 'held-read-password',
        RALLAR_BLACK_BOX_BROWSER_ENGINE: 'chromium',
        RALLAR_BLACK_BOX_HEADLESS_ENTRY: 'headless',
        RALLAR_BLACK_BOX_HEADLESS: '1',
        RALLAR_BLACK_BOX_EXIT_MODE: 'signal',
        RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS: '10000',
        RALLAR_BLACK_BOX_READY_TIMEOUT_MS: '10000',
        RALLAR_BLACK_BOX_PAGE_DISCONNECT_TIMEOUT_MS: String(pageDisconnectTimeoutMs)
    };
}

async function stopHeldReadAgent(agent: HeldReadAgent): Promise<void> {
    await new Promise<void>((resolve) => agent.readServer.close(() => resolve()));
    await closeServer(agent.controlServer);
    await closeServer(agent.spaServer);
}

async function stopWorker(runningWorker: ReturnType<typeof startHeadlessWorker> | undefined): Promise<void> {
    if (runningWorker && runningWorker.worker.exitCode === null && runningWorker.worker.signalCode === null) {
        runningWorker.worker.kill('SIGKILL');
        await runningWorker.result.catch(() => undefined);
    }
}

async function within<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    }
    finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

describe('rallar-black-box headless worker script', () => {
    it('redacts malformed credential-bearing startup configuration errors', async () => {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            RALLAR_BLACK_BOX_SPA_URL: 'https://blackbox.example.test',
            RALLAR_BLACK_BOX_CONTROL_URL: 'ftp://operator:startup-password@control.example.test/?controlToken=startup-token',
            RALLAR_API_BASE_URL: 'https://api.example.test',
            RALLAR_BLACK_BOX_RUN_ID: 'run-1',
            RALLAR_BLACK_BOX_ROOM_ID: 'room-1',
            RALLAR_BLACK_BOX_AGENT_COUNT: '1',
            RALLAR_BLACK_BOX_USERNAME: 'operator',
            RALLAR_BLACK_BOX_PASSWORD: 'startup-password',
            RALLAR_BLACK_BOX_CONTROL_TOKEN: 'startup-token',
            RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: 'startup-read-token'
        };
        delete env.RALLAR_CONTROL_HTTP_URL;

        const result = await runHeadlessWorker(env);

        expect(result.exitCode).toBe(1);
        expect(result.output).not.toContain('startup-password');
        expect(result.output).not.toContain('startup-token');
        expect(result.output).not.toContain('startup-read-token');
        expect(result.output).toContain('Control URL must use ws, wss, http, or https');
        expect(result.output).toContain('controlToken=[REDACTED]');
    });

    it('exits gracefully when SIGTERM interrupts agent registration', async () => {
        let markRegistrationStarted!: () => void;
        const registrationStarted = new Promise<void>((resolve) => {
            markRegistrationStarted = resolve;
        });
        const spaServer = createServer((_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.end('<!doctype html><html><body>worker test</body></html>');
        });
        const controlServer = createServer(() => {
            markRegistrationStarted();
        });
        let runningWorker: ReturnType<typeof startHeadlessWorker> | undefined;

        try {
            const spaPort = await listenOnLoopback(spaServer);
            const controlPort = await listenOnLoopback(controlServer);
            const spaUrl = `http://127.0.0.1:${spaPort}`;
            const controlUrl = `http://127.0.0.1:${controlPort}`;
            runningWorker = startHeadlessWorker({
                ...process.env,
                RALLAR_BLACK_BOX_SPA_URL: spaUrl,
                RALLAR_BLACK_BOX_CONTROL_URL: controlUrl,
                RALLAR_CONTROL_HTTP_URL: controlUrl,
                RALLAR_API_BASE_URL: `${spaUrl}/api`,
                RALLAR_BLACK_BOX_RUN_ID: 'run-sigterm-registration',
                RALLAR_BLACK_BOX_ROOM_ID: 'room-sigterm-registration',
                RALLAR_BLACK_BOX_AGENT_COUNT: '1',
                RALLAR_BLACK_BOX_AGENT_START_INDEX: '1',
                RALLAR_BLACK_BOX_AGENT_PREFIX: 'signal-agent',
                RALLAR_BLACK_BOX_USERNAME: 'operator',
                RALLAR_BLACK_BOX_PASSWORD: 'signal-password',
                RALLAR_BLACK_BOX_AGENT_1_USERNAME: 'operator',
                RALLAR_BLACK_BOX_AGENT_1_PASSWORD: 'signal-password',
                RALLAR_BLACK_BOX_BROWSER_ENGINE: 'chromium',
                RALLAR_BLACK_BOX_HEADLESS_ENTRY: 'operator-spa',
                RALLAR_BLACK_BOX_HEADLESS: '1',
                RALLAR_BLACK_BOX_EXIT_MODE: 'signal',
                RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS: '10000',
                RALLAR_BLACK_BOX_READY_TIMEOUT_MS: '30000'
            });

            await within(
                registrationStarted,
                10_000,
                'Worker did not start registration'
            );
            expect(runningWorker.worker.kill('SIGTERM')).toBe(true);
            const result = await within(
                runningWorker.result,
                5_000,
                'Worker did not exit after SIGTERM'
            );

            expect.soft(result.exitCode).toBe(0);
            expect.soft(result.output).toContain('Received SIGTERM; shutting down');
            expect.soft(result.output).not.toContain(
                'Error: Received SIGTERM; shutting down'
            );
            expect.soft(result.output).toContain(
                'Rallar black-box headless worker stopped.'
            );
        }
        finally {
            if (
                runningWorker &&
                runningWorker.worker.exitCode === null &&
                runningWorker.worker.signalCode === null
            ) {
                runningWorker.worker.kill('SIGKILL');
                await runningWorker.result.catch(() => undefined);
            }
            await closeServer(controlServer);
            await closeServer(spaServer);
        }
    }, 20_000);

    it('disconnects a page holding a live read before closing its browser context', async () => {
        const agent = await startHeldReadAgent(
            'socket.close(1000, \'orderly disconnect\'); await closed; return { status: \'closed\' };'
        );
        let runningWorker: ReturnType<typeof startHeadlessWorker> | undefined;

        try {
            runningWorker = startHeadlessWorker(toHeldReadWorkerEnv(agent, 10_000));
            await within(agent.readOpened, 15_000, 'Agent page did not open its held read');
            await within(
                waitForOutput(runningWorker, 'headless agents are registered'),
                15_000,
                'Worker did not register its agent'
            );
            expect(runningWorker.worker.kill('SIGTERM')).toBe(true);
            const result = await within(runningWorker.result, 15_000, 'Worker did not exit after SIGTERM');
            const readClose = await within(agent.readClosed, 1_000, 'Held read never closed');

            expect.soft(result.exitCode).toBe(0);
            expect.soft(readClose).toEqual({ code: ORDERLY_CLOSE_CODE, reason: 'orderly disconnect' });
            expect.soft(result.output.indexOf(`Agent ${HELD_READ_AGENT_ID} page disconnected`)).toBeGreaterThan(-1);
            expect.soft(result.output.indexOf(`Agent ${HELD_READ_AGENT_ID} page disconnected`)).toBeLessThan(
                result.output.indexOf(`Closing agent ${HELD_READ_AGENT_ID}`)
            );
        }
        finally {
            await stopWorker(runningWorker);
            await stopHeldReadAgent(agent);
        }
    }, 45_000);

    it('closes the browser context once a page disconnect exceeds its bound', async () => {
        const agent = await startHeldReadAgent('await new Promise(() => undefined);');
        let runningWorker: ReturnType<typeof startHeadlessWorker> | undefined;

        try {
            runningWorker = startHeadlessWorker(toHeldReadWorkerEnv(agent, 500));
            await within(agent.readOpened, 15_000, 'Agent page did not open its held read');
            await within(
                waitForOutput(runningWorker, 'headless agents are registered'),
                15_000,
                'Worker did not register its agent'
            );
            expect(runningWorker.worker.kill('SIGTERM')).toBe(true);
            const result = await within(runningWorker.result, 10_000, 'Worker did not exit after SIGTERM');

            expect.soft(result.exitCode).toBe(0);
            expect.soft(result.output).toContain(`Agent ${HELD_READ_AGENT_ID} page disconnect exceeded 500ms`);
            expect.soft(result.output).toContain('Rallar black-box headless worker stopped.');
        }
        finally {
            await stopWorker(runningWorker);
            await stopHeldReadAgent(agent);
        }
    }, 45_000);
});
