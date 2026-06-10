import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {describe, expect, it} from 'vitest';
import {executeBlackBox} from '../../shared-test/black-box-runner/execute-black-box.ts';

async function startHttpServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string, close: () => Promise<void> }> {
    const server = createServer(handler);

    await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve);
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

function json(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(body));
}

describe('executeBlackBox', () => {
    it('reports the explicit rallar-signaling RTC provider alias', async () => {
        const report = await executeBlackBox([], 0, {
            failFast: true,
        });

        expect(report.rtcProviderNames).toContain('rallar');
        expect(report.rtcProviderNames).toContain('rallar-signaling');
    });

    it('supports SET output and placeholder resolution', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'auth',
                            value: {
                                body: {
                                    token_type: 'Bearer',
                                    access_token: 'abc-123',
                                },
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setAuth: {},
                },
                {
                    SET: {
                        request: {
                            output: 'authHeader',
                            value: '{auth.body.token_type} {auth.body.access_token}',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    deriveAuthHeader: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.authHeader).toBe('Bearer abc-123');
    });

    it('supports exact object placeholder values', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'auth',
                            value: {
                                body: {
                                    access_token: 'abc-123',
                                    token_type: 'Bearer',
                                },
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setAuth: {},
                },
                {
                    SET: {
                        request: {
                            output: 'authBody',
                            value: '{auth.body}',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    deriveAuthBody: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.authBody).toEqual({
            access_token: 'abc-123',
            token_type: 'Bearer',
        });
    });

    it('supports ASSERT success with compatible comparison', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'user',
                            value: {
                                id: 123,
                                name: 'Alice',
                                traceId: 'dynamic-value',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setUser: {},
                },
                {
                    ASSERT: {
                        request: {
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            actual: '{user}',
                            body: {
                                id: 'integer',
                                name: 'string',
                            },
                        },
                    },
                    assertUserShape: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.assertUserShape[0].status).toBe('SUCCESS');
    });

    it('reports ASSERT failure', async () => {
        const report = await executeBlackBox(
            [
                {
                    ASSERT: {
                        request: {
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {
                            actual: {
                                id: 'not-an-integer',
                            },
                            body: {
                                id: 'integer',
                            },
                        },
                    },
                    assertUserShape: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(report.summary.firstFailure.name).toBe('assertUserShape');
        expect(report.resultsByName.assertUserShape[0].status).toBe('FAILURE');
    });

    it('supports failFast false', async () => {
        const report = await executeBlackBox(
            [
                {
                    ASSERT: {
                        request: {
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {
                            actual: {
                                id: 'not-an-integer',
                            },
                            body: {
                                id: 'integer',
                            },
                        },
                    },
                    firstAssertFails: {},
                },
                {
                    SET: {
                        request: {
                            output: 'afterFailure',
                            value: 'still-runs',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    setAfterFailure: {},
                },
            ],
            0,
            {
                failFast: false,
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(report.summary.success).toBe(1);
        expect(report.outputs.afterFailure).toBe('still-runs');
    });

    it('supports variables in placeholders', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'url',
                            value: '{variables.baseUrl}/users',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    deriveUrl: {},
                },
            ],
            0,
            {
                variables: {
                    baseUrl: 'http://localhost:8080',
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.url).toBe('http://localhost:8080/users');
    });

    it('extracts HTTP outputs and accepts status/body outcome sets', async () => {
        const server = await startHttpServer((_request, response) => {
            json(response, 409, {
                code: 'already-exists',
                group: {
                    id: 'group-1',
                    name: 'bb-group',
                },
            });
        });

        try {
            const report = await executeBlackBox(
                [
                    {
                        HTTP: {
                            request: {
                                path: `${server.url}/groups`,
                                method: 'POST',
                                body: {
                                    name: 'bb-group',
                                },
                                output: 'groupName',
                                outputPath: 'body.group.name',
                                outputs: {
                                    groupId: 'body.group.id',
                                    createStatus: 'statusCode',
                                },
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 1,
                            },
                            response: {
                                statusCode: [201, 409],
                                bodyAnyOf: [
                                    {
                                        group: {
                                            id: 'string',
                                        },
                                    },
                                    {
                                        code: 'already-exists',
                                        group: {
                                            name: 'bb-group',
                                        },
                                    },
                                ],
                            },
                        },
                        createGroup: {},
                    },
                    {
                        SET: {
                            request: {
                                output: 'joinPath',
                                value: '/groups/{groupId}/join/{createStatus}',
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 2,
                            },
                            response: {},
                        },
                        deriveJoinPath: {},
                    },
                ],
                0,
                {
                    failFast: true,
                },
            );

            expect(report.summary.failure).toBe(0);
            expect(report.outputs.groupName).toBe('bb-group');
            expect(report.outputs.groupId).toBe('group-1');
            expect(report.outputs.createStatus).toBe(409);
            expect(report.outputs.joinPath).toBe('/groups/group-1/join/409');
        } finally {
            await server.close();
        }
    });

    it('extracts outputs from WebSocket send results', async () => {
        const originalWebSocket = globalThis.WebSocket;

        class FakeWebSocket {
            static CONNECTING = 0;
            static OPEN = 1;
            static CLOSING = 2;
            static CLOSED = 3;

            readyState = FakeWebSocket.CONNECTING;
            bufferedAmount = 0;
            onopen: ((event: unknown) => void) | undefined;
            onmessage: ((event: { data: unknown }) => void) | undefined;
            onclose: ((event: unknown) => void) | undefined;
            onerror: ((event: unknown) => void) | undefined;

            constructor(public readonly url: string) {
                setTimeout(() => {
                    this.readyState = FakeWebSocket.OPEN;
                    this.onopen?.({
                        url: this.url,
                    });
                }, 0);
            }

            send(data: unknown): void {
                this.bufferedAmount = String(data).length;
                setTimeout(() => {
                    this.onmessage?.({
                        data,
                    });
                }, 0);
            }

            close(code?: number, reason?: string): void {
                this.readyState = FakeWebSocket.CLOSED;
                this.onclose?.({
                    code,
                    reason,
                    wasClean: true,
                });
            }
        }

        (globalThis as any).WebSocket = FakeWebSocket;

        try {
            const report = await executeBlackBox(
                [
                    {
                        WS: {
                            request: {
                                action: 'open',
                                connection: 'echoWs',
                                path: 'ws://example.invalid/echo',
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 1,
                            },
                            response: {},
                        },
                        openEchoWs: {},
                    },
                    {
                        WS: {
                            request: {
                                action: 'send',
                                connection: 'echoWs',
                                send: {
                                    kind: 'bb.echo',
                                    payload: {
                                        text: 'hello ws',
                                    },
                                },
                                output: 'wsSendStatus',
                                outputPath: 'sendResult.status',
                                outputs: {
                                    wsReadyState: 'sendResult.readyStateName',
                                    wsWirePayload: 'sendResult.wirePayload',
                                    echoedKind: 'matchedMessage.data.kind',
                                },
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 2,
                            },
                            response: {
                                connection: 'echoWs',
                                withinMs: 1000,
                                message: {
                                    kind: 'bb.echo',
                                    payload: {
                                        text: 'hello ws',
                                    },
                                },
                            },
                        },
                        sendEchoWs: {},
                    },
                ],
                0,
                {
                    failFast: true,
                },
            );

            expect(report.summary.failure).toBe(0);
            expect(report.outputs.wsSendStatus).toBe('sent');
            expect(report.outputs.wsReadyState).toBe('OPEN');
            expect(report.outputs.wsWirePayload).toBe('{"kind":"bb.echo","payload":{"text":"hello ws"}}');
            expect(report.outputs.echoedKind).toBe('bb.echo');
            expect(typeof report.resultsByName.sendEchoWs[0].actual.sendLatencyMs).toBe('number');
        } finally {
            (globalThis as any).WebSocket = originalWebSocket;
        }
    });

    it('extracts outputs from RTC provider send results', async () => {
        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-stub',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
                {
                    RTC: {
                        request: {
                            action: 'send',
                            connection: 'aliceRtc',
                            provider: 'rallar-stub',
                            send: {
                                data: {
                                    text: 'hello bob',
                                },
                            },
                            deliverTo: 'bobRtc',
                            output: 'sentText',
                            outputPath: 'deliveredMessages[0].data.text',
                            outputs: {
                                firstTarget: 'deliverTargets.0',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    sendAlice: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.sentText).toBe('hello bob');
        expect(report.outputs.firstTarget).toBe('bobRtc');
    });

    it('fails a successful step when configured output extraction is missing', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'missingValue',
                            outputPath: 'body.missing',
                            value: {
                                body: {
                                    present: true,
                                },
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setMissingOutput: {},
                },
                {
                    SET: {
                        request: {
                            output: 'afterFailure',
                            value: 'should-not-run',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    afterFailure: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(report.summary.success).toBe(0);
        expect(report.resultsByName.setMissingOutput[0].result).toBe('Output extraction failed');
        expect(report.outputs.missingValue).toBeUndefined();
        expect(report.outputs.afterFailure).toBeUndefined();
    });

    it('supports ASSERT expected outcome sets', async () => {
        const report = await executeBlackBox(
            [
                {
                    ASSERT: {
                        request: {
                            actual: {
                                code: 'already-exists',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {
                            anyOf: [
                                {
                                    code: 'created',
                                },
                                {
                                    code: 'already-exists',
                                },
                            ],
                        },
                    },
                    assertIdempotentOutcome: {},
                },
            ],
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.assertIdempotentOutcome[0].details.anyOfMatchedIndex).toBe(1);
    });
});
