import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {describe, expect, it} from 'vitest';
import {executeBlackBox} from '../../shared-test/black-box-runner/execute-black-box.ts';

async function tryStartHttpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string, close: () => Promise<void> } | undefined> {
    const server = createServer(handler);

    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
        if (code === 'EPERM' || code === 'EACCES') {
            return undefined;
        }
        throw error;
    }

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to start HTTP test server');
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        }),
    };
}

function slowOkHandler(delayMs: number) {
    return (_request: IncomingMessage, response: ServerResponse): void => {
        setTimeout(() => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true }));
        }, delayMs);
    };
}

function httpStep(path: string, expectFields: Record<string, unknown>): Record<string, unknown> {
    return {
        HTTP: {
            request: {
                method: 'GET',
                path,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 1,
            },
            response: expectFields,
        },
        boundedRead: {},
    };
}

describe('executeBlackBox expect.maxDurationMs', () => {
    it('keeps a fast successful step successful and reports the bound', async () => {
        const server = await tryStartHttpServer(slowOkHandler(0));
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [httpStep(`${server.url}/fast`, {
                    status: 200,
                    maxDurationMs: 10000,
                    body: { ok: true },
                })],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(0);
            const result = report.resultsByName.boundedRead[0];
            expect(result.status).toBe('SUCCESS');
            expect(result.maxDurationMs).toBe(10000);
            expect(result.durationMs).toBeLessThanOrEqual(10000);
        } finally {
            await server.close();
        }
    });

    it('fails a successful step whose duration exceeds the bound', async () => {
        const server = await tryStartHttpServer(slowOkHandler(150));
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [httpStep(`${server.url}/slow`, {
                    status: 200,
                    maxDurationMs: 50,
                    body: { ok: true },
                })],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(1);
            const result = report.resultsByName.boundedRead[0];
            expect(result.status).toBe('FAILURE');
            expect(result.result).toBe('Step duration exceeded expect.maxDurationMs');
            expect(result.maxDurationMs).toBe(50);
            expect(result.durationMs).toBeGreaterThan(50);
            expect(result.actual.body.ok).toBe(true);
        } finally {
            await server.close();
        }
    });

    it('never masks the step failure when the expectation itself fails', async () => {
        const server = await tryStartHttpServer(slowOkHandler(150));
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [httpStep(`${server.url}/slow`, {
                    status: 200,
                    maxDurationMs: 50,
                    body: { ok: false },
                })],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(1);
            const result = report.resultsByName.boundedRead[0];
            expect(result.result).toBe('Expected response not the same as actual response');
            expect(result.maxDurationMs).toBe(50);
        } finally {
            await server.close();
        }
    });

    it('bounds a WS wait that always holds its full absence window', async () => {
        const originalWebSocket = globalThis.WebSocket;

        class InstantOpenWebSocket {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSING = 2;
            static CLOSED = 3;

            readyState = InstantOpenWebSocket.CONNECTING;
            onopen: ((event: unknown) => void) | undefined;
            onmessage: ((event: { data: unknown }) => void) | undefined;
            onclose: ((event: unknown) => void) | undefined;
            onerror: ((event: unknown) => void) | undefined;

            constructor(public readonly url: string) {
                setTimeout(() => {
                    this.readyState = InstantOpenWebSocket.OPEN;
                    this.onopen?.({ url: this.url });
                }, 0);
            }

            send(): void {}

            close(): void {
                this.readyState = InstantOpenWebSocket.CLOSED;
            }
        }

        (globalThis as any).WebSocket = InstantOpenWebSocket;
        try {
            const report = await executeBlackBox(
                [
                    {
                        WS: {
                            request: {
                                action: 'open',
                                connection: 'quietWs',
                                path: 'ws://example.invalid/quiet',
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 1,
                            },
                            response: {},
                        },
                        openQuietWs: {},
                    },
                    {
                        WS: {
                            request: {
                                action: 'wait',
                                connection: 'quietWs',
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 2,
                            },
                            response: {
                                connection: 'quietWs',
                                withinMs: 200,
                                maxDurationMs: 50,
                                absent: { kind: 'never-sent' },
                            },
                        },
                        boundedQuietWait: {},
                    },
                ],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(1);
            const result = report.resultsByName.boundedQuietWait[0];
            expect(result.status).toBe('FAILURE');
            expect(result.result).toBe('Step duration exceeded expect.maxDurationMs');
        } finally {
            (globalThis as any).WebSocket = originalWebSocket;
        }
    });
});
