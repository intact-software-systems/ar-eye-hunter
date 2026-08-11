import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {describe, expect, it} from 'vitest';
import {executeBlackBox} from '../../shared-test/black-box-runner/execute-black-box.ts';

async function startHttpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string, close: () => Promise<void> }> {
    const server = createServer(handler);

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to start HTTP test server');
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        }),
    };
}

async function tryStartHttpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string, close: () => Promise<void> } | undefined> {
    try {
        return await startHttpServer(handler);
    } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : '';
        if (code === 'EPERM' || code === 'EACCES') {
            return undefined;
        }
        throw error;
    }
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(body));
}

function pollUntilStep(input: {
    path: string;
    poll: Record<string, unknown>;
    expectBody: Record<string, unknown>;
    nonBlockingFailure?: boolean;
}): Record<string, unknown> {
    return {
        HTTP: {
            request: {
                action: 'poll-until',
                method: 'GET',
                path: input.path,
                poll: input.poll,
                nonBlockingFailure: input.nonBlockingFailure,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 1,
            },
            response: {
                status: 200,
                body: input.expectBody,
            },
        },
        pollUntilConverged: {},
    };
}

describe('executeBlackBox http poll-until', () => {
    it('repeats the request until its expect passes', async () => {
        let calls = 0;
        const server = await tryStartHttpServer((_request, response) => {
            calls++;
            if (calls < 3) {
                json(response, 200, { converged: false, revision: calls });
                return;
            }
            json(response, 200, { converged: true, revision: calls });
        });
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [pollUntilStep({
                    path: `${server.url}/state`,
                    poll: { maxAttempts: 10, maxDurationMs: 5000, backoffMs: 10, backoffMultiplier: 1 },
                    expectBody: { converged: true },
                })],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(0);
            const result = report.resultsByName.pollUntilConverged[0];
            expect(result.status).toBe('SUCCESS');
            expect(result.pollAttempts).toBe(3);
            expect(result.pollExhausted).toBe(false);
            expect(result.actual.body.converged).toBe(true);
            expect(calls).toBe(3);
        } finally {
            await server.close();
        }
    });

    it('fails with the last attempt status when max attempts are exhausted', async () => {
        let calls = 0;
        const server = await tryStartHttpServer((_request, response) => {
            calls++;
            json(response, 200, { converged: false, revision: calls });
        });
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [pollUntilStep({
                    path: `${server.url}/state`,
                    poll: { maxAttempts: 4, maxDurationMs: 5000, backoffMs: 5, backoffMultiplier: 1 },
                    expectBody: { converged: true },
                })],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(1);
            const result = report.resultsByName.pollUntilConverged[0];
            expect(result.status).toBe('FAILURE');
            expect(result.result).toBe('Expected response not the same as actual response');
            expect(result.pollAttempts).toBe(4);
            expect(result.pollExhausted).toBe(true);
            expect(calls).toBe(4);
        } finally {
            await server.close();
        }
    });

    it('stops polling when the max duration bound would be exceeded', async () => {
        let calls = 0;
        const server = await tryStartHttpServer((_request, response) => {
            calls++;
            json(response, 200, { converged: false });
        });
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [pollUntilStep({
                    path: `${server.url}/state`,
                    poll: { maxAttempts: 100, maxDurationMs: 150, backoffMs: 60, backoffMultiplier: 2 },
                    expectBody: { converged: true },
                })],
                0,
                { failFast: true },
            );

            expect(report.summary.failure).toBe(1);
            const result = report.resultsByName.pollUntilConverged[0];
            expect(result.status).toBe('FAILURE');
            expect(result.pollExhausted).toBe(true);
            expect(result.pollAttempts).toBeLessThan(100);
            expect(result.pollElapsedMs).toBeLessThanOrEqual(1000);
            expect(calls).toBeLessThan(10);
        } finally {
            await server.close();
        }
    });

    it('keeps polling across connection failures and marks the step non-blocking when asked', async () => {
        const report = await executeBlackBox(
            [
                pollUntilStep({
                    path: 'http://127.0.0.1:1/unreachable',
                    poll: { maxAttempts: 2, maxDurationMs: 2000, backoffMs: 5, backoffMultiplier: 1 },
                    expectBody: { converged: true },
                    nonBlockingFailure: true,
                }),
                {
                    SET: {
                        request: {
                            output: 'afterPoll',
                            value: 'reached',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    continuesAfterNonBlockingPoll: {},
                },
            ],
            0,
            { failFast: true },
        );

        const result = report.resultsByName.pollUntilConverged[0];
        expect(result.status).toBe('FAILURE');
        expect(result.nonBlockingFailure).toBe(true);
        expect(result.pollAttempts).toBe(2);
        expect(result.pollExhausted).toBe(true);
        expect(typeof result.exception).toBe('string');
        expect(report.outputs.afterPoll).toBe('reached');
        expect(report.summary.failure).toBe(0);
        expect(report.summary.observedFailure).toBe(1);
    });
});
