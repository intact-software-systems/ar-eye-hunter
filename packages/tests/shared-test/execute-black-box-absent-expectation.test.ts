import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

class EchoFakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = EchoFakeWebSocket.CONNECTING;
    bufferedAmount = 0;
    onopen: ((event: unknown) => void) | undefined;
    onmessage: ((event: { data: unknown; }) => void) | undefined;
    onclose: ((event: unknown) => void) | undefined;
    onerror: ((event: unknown) => void) | undefined;

    public readonly url: string;

    constructor(url: string) {
        this.url = url;
        setTimeout(() => {
            this.readyState = EchoFakeWebSocket.OPEN;
            this.onopen?.({
                url: this.url
            });
        }, 0);
    }

    send(data: unknown): void {
        this.bufferedAmount = String(data).length;
        setTimeout(() => {
            this.onmessage?.({
                data
            });
        }, 0);
    }

    close(code?: number, reason?: string): void {
        this.readyState = EchoFakeWebSocket.CLOSED;
        this.onclose?.({
            code,
            reason,
            wasClean: true
        });
    }
}

function wsOpenStep(interactionExecutionNumber: number): Record<string, unknown> {
    return {
        WS: {
            request: {
                action: 'open',
                connection: 'echoWs',
                path: 'ws://example.invalid/echo',
                scenarioExecutionNumber: 1,
                interactionExecutionNumber
            },
            response: {}
        },
        openEchoWs: {}
    };
}

function wsSendStep(interactionExecutionNumber: number): Record<string, unknown> {
    return {
        WS: {
            request: {
                action: 'send',
                connection: 'echoWs',
                send: {
                    kind: 'bb.echo',
                    scopeId: 'application-a'
                },
                scenarioExecutionNumber: 1,
                interactionExecutionNumber
            },
            response: {
                connection: 'echoWs',
                withinMs: 1000,
                message: {
                    kind: 'bb.echo',
                    scopeId: 'application-a'
                }
            }
        },
        sendEchoWs: {}
    };
}

function wsAbsentWaitStep(
    interactionExecutionNumber: number,
    absent: Record<string, unknown>
): Record<string, unknown> {
    return {
        WS: {
            request: {
                action: 'wait',
                connection: 'echoWs',
                scenarioExecutionNumber: 1,
                interactionExecutionNumber
            },
            response: {
                connection: 'echoWs',
                withinMs: 120,
                absent
            }
        },
        expectNoForeignScopeFrame: {}
    };
}

async function withEchoWebSocket<T>(run: () => Promise<T>): Promise<T> {
    const originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = EchoFakeWebSocket;
    try {
        return await run();
    }
    finally {
        (globalThis as any).WebSocket = originalWebSocket;
    }
}

describe('executeBlackBox expect.absent', () => {
    it('passes a WS absence wait when no buffered frame matches within the window', async () => {
        const report = await withEchoWebSocket(() =>
            executeBlackBox(
                [
                    wsOpenStep(1),
                    wsSendStep(2),
                    wsAbsentWaitStep(3, {
                        kind: 'bb.echo',
                        scopeId: 'application-b'
                    })
                ],
                0,
                {
                    failFast: true
                }
            )
        );

        expect(report.summary.failure).toBe(0);
        const absenceResult = report.resultsByName.expectNoForeignScopeFrame[0];
        expect(absenceResult.status).toBe('SUCCESS');
        expect(absenceResult.actual.matchedMessage).toBeUndefined();
        expect(absenceResult.actual.observedMessageCount).toBe(1);
        expect(absenceResult.actual.waitedMs).toBeGreaterThanOrEqual(100);
    });

    it('fails a WS absence wait with the offending frame when a match arrives', async () => {
        const report = await withEchoWebSocket(() =>
            executeBlackBox(
                [
                    wsOpenStep(1),
                    wsSendStep(2),
                    wsAbsentWaitStep(3, {
                        kind: 'bb.echo',
                        scopeId: 'application-a'
                    })
                ],
                0,
                {
                    failFast: true
                }
            )
        );

        expect(report.summary.failure).toBe(1);
        const absenceResult = report.resultsByName.expectNoForeignScopeFrame[0];
        expect(absenceResult.status).toBe('FAILURE');
        expect(absenceResult.result).toBe('WebSocket message expected to be absent was received');
        expect(absenceResult.actual.matchedMessage.data).toEqual({
            kind: 'bb.echo',
            scopeId: 'application-a'
        });
        expect(absenceResult.actual.waitedMs).toBeGreaterThanOrEqual(100);
    });

    it('fails a WS absence wait without a matcher', async () => {
        const report = await withEchoWebSocket(() =>
            executeBlackBox(
                [
                    wsOpenStep(1),
                    {
                        WS: {
                            request: {
                                action: 'wait',
                                connection: 'echoWs',
                                scenarioExecutionNumber: 1,
                                interactionExecutionNumber: 2
                            },
                            response: {
                                connection: 'echoWs',
                                withinMs: 50,
                                absent: null
                            }
                        },
                        absentWithoutMatcher: {}
                    }
                ],
                0,
                {
                    failFast: true
                }
            )
        );

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.absentWithoutMatcher[0].result).toBe(
            'WebSocket absence wait expects expect.absent to be a partial message matcher.'
        );
    });

    it('passes and fails RTC absence waits against the stub provider buffers', async () => {
        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            provider: 'rallar-stub',
                            connection: 'actorA',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    connectActorA: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            provider: 'rallar-stub',
                            connection: 'actorB',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2
                        },
                        response: {}
                    },
                    connectActorB: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'send',
                            provider: 'rallar-stub',
                            connection: 'actorA',
                            deliverTo: 'actorB',
                            send: {
                                kind: 'bb.room-event',
                                groupId: 'group-application-a'
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3
                        },
                        response: {}
                    },
                    sendFromActorA: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'wait',
                            provider: 'rallar-stub',
                            connection: 'actorB',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 4
                        },
                        response: {
                            connection: 'actorB',
                            withinMs: 120,
                            absent: {
                                kind: 'bb.room-event',
                                groupId: 'group-application-b'
                            }
                        }
                    },
                    expectNoForeignGroupMessage: {}
                },
                {
                    RTC: {
                        request: {
                            action: 'wait',
                            provider: 'rallar-stub',
                            connection: 'actorB',
                            nonBlockingFailure: true,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 5
                        },
                        response: {
                            connection: 'actorB',
                            withinMs: 120,
                            absent: {
                                kind: 'bb.room-event',
                                groupId: 'group-application-a'
                            }
                        }
                    },
                    expectDeliveredMessageAbsenceFails: {}
                }
            ],
            0,
            {
                failFast: true
            }
        );

        const absentPass = report.resultsByName.expectNoForeignGroupMessage[0];
        expect(absentPass.status).toBe('SUCCESS');
        expect(absentPass.actual.matchedMessage).toBeUndefined();
        expect(absentPass.actual.waitedMs).toBeGreaterThanOrEqual(100);

        const absentFail = report.resultsByName.expectDeliveredMessageAbsenceFails[0];
        expect(absentFail.status).toBe('FAILURE');
        expect(absentFail.nonBlockingFailure).toBe(true);
        expect(absentFail.result).toBe('RTC message expected to be absent was received');
        expect(absentFail.actual.matchedMessage.data).toEqual({
            kind: 'bb.room-event',
            groupId: 'group-application-a'
        });
    });
});
