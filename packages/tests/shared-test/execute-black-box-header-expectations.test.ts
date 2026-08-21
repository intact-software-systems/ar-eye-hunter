import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

async function tryStartHttpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void>; } | undefined> {
    const server = createServer(handler);

    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
    }
    catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown; }).code)
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
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            })
    };
}

function revisionHeaderHandler(_request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Rallar-State-Revision': '7',
        'Rallar-State-Source': 'durable'
    });
    response.end(JSON.stringify({ stateRevision: 7 }));
}

function httpStep(path: string, expectFields: Record<string, unknown>): Record<string, unknown> {
    return {
        HTTP: {
            request: {
                method: 'GET',
                path,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 1
            },
            response: expectFields
        },
        readWithHeaderExpectations: {}
    };
}

describe('executeBlackBox HTTP expect.headers', () => {
    it('matches exact values and type tokens with case-insensitive names', async () => {
        const server = await tryStartHttpServer(revisionHeaderHandler);
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [httpStep(`${server.url}/state`, {
                    status: 200,
                    headers: {
                        'Rallar-State-Revision': '7',
                        'RALLAR-STATE-SOURCE': 'string',
                        'cache-control': 'no-store'
                    },
                    body: { stateRevision: 7 }
                })],
                0,
                { failFast: true }
            );

            expect(report.summary.failure).toBe(0);
            expect(report.resultsByName.readWithHeaderExpectations[0].status).toBe('SUCCESS');
        }
        finally {
            await server.close();
        }
    });

    it('fails on a header value mismatch with the header comparison details', async () => {
        const server = await tryStartHttpServer(revisionHeaderHandler);
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [httpStep(`${server.url}/state`, {
                    status: 200,
                    headers: {
                        'Rallar-State-Revision': '8'
                    }
                })],
                0,
                { failFast: true }
            );

            expect(report.summary.failure).toBe(1);
            const result = report.resultsByName.readWithHeaderExpectations[0];
            expect(result.result).toBe(
                'Expected response headers not the same as actual response headers'
            );
            expect(result.details.headerComparison.isEqual).toBe(false);
            expect(result.actual.headers['rallar-state-revision']).toBe('7');
        }
        finally {
            await server.close();
        }
    });

    it('fails when an expected observability header is missing from the response', async () => {
        const server = await tryStartHttpServer((_request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true }));
        });
        if (!server) {
            return;
        }

        try {
            const report = await executeBlackBox(
                [httpStep(`${server.url}/state`, {
                    status: 200,
                    headers: {
                        'Rallar-State-Source': 'string'
                    }
                })],
                0,
                { failFast: true }
            );

            expect(report.summary.failure).toBe(1);
            expect(report.resultsByName.readWithHeaderExpectations[0].result).toBe(
                'Expected response headers not the same as actual response headers'
            );
        }
        finally {
            await server.close();
        }
    });
});
