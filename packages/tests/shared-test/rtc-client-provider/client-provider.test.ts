import { expect, test } from 'bun:test';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarInMemoryProvider } from '../../../shared-test/black-box-runner/rallar-in-memory-runtime.ts';
import { createRtcProviderFromClientFactory } from '../../../shared-test/black-box-runner/rtc-provider.ts';
import { createFakeRtcClient } from './fake-rtc-client.ts';

test('createRtcProviderFromClientFactory preserves failed send result details', async () => {
    const fakeClient = createFakeRtcClient();
    fakeClient.send = async () => {
        const error = new Error('fake send had no route') as Error & {
            sendResult?: unknown;
            diagnostics?: unknown;
        };
        error.sendResult = {
            status: 'no-peers',
            peerIds: []
        };
        error.diagnostics = {
            phase: 'send',
            reason: 'no-route'
        };
        throw error;
    };

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        send: {
                            topic: 'chat.message'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsWithoutRoute: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    const sendResult = report.resultsByName.aliceSendsWithoutRoute[0];

    expect(report.summary.failure).toEqual(1);
    expect(sendResult.status).toEqual('FAILURE');
    expect(sendResult.result).toEqual('RTC send failed');
    expect(sendResult.actual.sendResult).toEqual({
        status: 'no-peers',
        peerIds: []
    });
    expect(sendResult.actual.diagnostics).toEqual({
        phase: 'send',
        reason: 'no-route'
    });
    expect(typeof sendResult.actual.sendLatencyMs).toEqual('number');
});

test('RTC success status includes generic routing diagnostics', async () => {
    const provider = createRallarInMemoryProvider({ now: Date.now, state: { connections: new Map(), nextDeliverySequence: 1 } });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        remotePeerId: 'bob',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider
            }
        }
    );

    const result = report.resultsByName.connectAlice[0];

    expect(report.summary.failure).toEqual(0);
    expect(result.status).toEqual('SUCCESS');
    expect(result.peerId).toEqual('alice');
    expect(result.groupId).toEqual('group-1');
    expect(result.overlayId).toEqual('overlay-1');
    expect(result.remotePeerId).toEqual('bob');
    expect(result.actual.peerId).toEqual('alice');
    expect(result.actual.groupId).toEqual('group-1');
    expect(result.actual.overlayId).toEqual('overlay-1');
    expect(result.actual.remotePeerId).toEqual('bob');
});

test('createRtcProviderFromClientFactory supports rtc.wait expect.diagnostic', async () => {
    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const reportPromise = executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        withinMs: 1000,
                        diagnostic: {
                            topic: 'fake.rtc.ready',
                            data: {
                                phase: 'lane-open',
                                status: 'partial'
                            }
                        }
                    }
                },
                waitForDiagnostic: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    setTimeout(() => {
        fakeClient.emitMessage({
            kind: 'diagnostic',
            topic: 'fake.rtc.ready',
            data: {
                phase: 'lane-open',
                status: 'partial'
            }
        });
    }, 25);

    const report = await reportPromise;

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.waitForDiagnostic[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForDiagnostic[0].actual.matchedDiagnostic.topic).toEqual('fake.rtc.ready');
    expect(report.rtcDiagnostics.aliceRtc[0].topic).toEqual('fake.rtc.ready');
    expect(report.rtcMessages.aliceRtc[0].data.topic).toEqual('fake.rtc.ready');
});

test('createRtcProviderFromClientFactory supports rtc.wait expect.health', async () => {
    const fakeClient = createFakeRtcClient();
    let ready = false;
    fakeClient.diagnostics = () => ({
        ready,
        phase: ready ? 'ready' : 'connecting'
    });

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const reportPromise = executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        withinMs: 1000,
                        health: {
                            ready: true,
                            phase: 'ready'
                        }
                    }
                },
                waitForHealth: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    setTimeout(() => {
        ready = true;
    }, 25);

    const report = await reportPromise;

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.waitForHealth[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForHealth[0].actual.matchedHealth).toEqual({
        ready: true,
        phase: 'ready'
    });
});

test('createRtcProviderFromClientFactory reports RTC connect, send, and first-payload latency', async () => {
    const fakeClient = createFakeRtcClient();
    fakeClient.send = async (message: unknown) => {
        fakeClient.sentMessages.push(message);
        setTimeout(() => {
            fakeClient.emitMessage({
                topic: 'chat.message',
                payload: {
                    text: 'hello'
                }
            });
        }, 10);
    };

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        send: {
                            topic: 'chat.message'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        withinMs: 1000,
                        message: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello'
                            }
                        }
                    }
                },
                aliceSends: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    const connectResult = report.resultsByName.connectAlice[0];
    const sendResult = report.resultsByName.aliceSends[0];

    expect(report.summary.failure).toEqual(0);
    expect(typeof connectResult.actual.connectLatencyMs).toEqual('number');
    expect(typeof sendResult.actual.sendLatencyMs).toEqual('number');
    expect(typeof sendResult.actual.firstPayloadLatencyMs).toEqual('number');
    expect(sendResult.actual.firstPayloadLatencyMs >= 0).toEqual(true);
});

test('createRtcProviderFromClientFactory reports missing RTC diagnostics clearly', async () => {
    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        withinMs: 20,
                        diagnostic: {
                            topic: 'fake.rtc.never-ready'
                        }
                    }
                },
                waitForMissingDiagnostic: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.waitForMissingDiagnostic[0].result).toEqual('Expected RTC diagnostic was not received');
    expect(report.resultsByName.waitForMissingDiagnostic[0].actual.diagnostics).toEqual([]);
});

test('createRtcProviderFromClientFactory reports missing RTC health clearly', async () => {
    const fakeClient = createFakeRtcClient();
    fakeClient.diagnostics = () => ({
        ready: false,
        phase: 'connecting'
    });

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        withinMs: 20,
                        health: {
                            ready: true
                        }
                    }
                },
                waitForMissingHealth: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.waitForMissingHealth[0].result).toEqual('Expected RTC health was not observed');
    expect(report.resultsByName.waitForMissingHealth[0].actual.health).toEqual({
        ready: false,
        phase: 'connecting'
    });
});

test('RTC failure status includes generic routing diagnostics', async () => {
    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'missing-provider',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        remotePeerId: 'bob',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAliceMissingProvider: {}
            }
        ],
        0,
        {
            rtcProviders: {}
        }
    );

    const result = report.resultsByName.connectAliceMissingProvider[0];

    expect(report.summary.failure).toEqual(1);
    expect(result.status).toEqual('FAILURE');
    expect(result.peerId).toEqual('alice');
    expect(result.groupId).toEqual('group-1');
    expect(result.overlayId).toEqual('overlay-1');
    expect(result.remotePeerId).toEqual('bob');
    expect(result.actual.peerId).toEqual('alice');
    expect(result.actual.groupId).toEqual('group-1');
    expect(result.actual.overlayId).toEqual('overlay-1');
    expect(result.actual.remotePeerId).toEqual('bob');
});

test('createRtcProviderFromClientFactory connects client and stores connection', async () => {
    let createdRequest: unknown;
    let createdConfig: unknown;
    let createdContext: unknown;

    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: (request: any, config: any, context: any) => {
            createdRequest = request;
            createdConfig = config;
            createdContext = context;
            return fakeClient;
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.connectAlice[0].actual.connected).toEqual(true);
    expect(fakeClient.connected).toEqual(true);

    expect((createdRequest as any).connection).toEqual('aliceRtc');
    expect((createdConfig as any).interactionName).toEqual('connectAlice');
    expect((createdContext as any).rtcProviders.fake !== undefined).toEqual(true);
});

test('createRtcProviderFromClientFactory sends through connected client', async () => {
    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSends: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(fakeClient.sentMessages).toEqual([payload]);
    expect(report.resultsByName.aliceSends[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.aliceSends[0].actual.sent).toEqual(payload);
});

test('createRtcProviderFromClientFactory waits for client-emitted message', async () => {
    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const reportPromise = executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        withinMs: 1000,
                        message: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello'
                            }
                        }
                    }
                },
                waitForMessage: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    setTimeout(() => {
        fakeClient.emitMessage({
            topic: 'chat.message',
            payload: {
                text: 'hello'
            }
        });
    }, 25);

    const report = await reportPromise;

    expect(report.summary.failure).toEqual(0);
    expect(report.resultsByName.waitForMessage[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.waitForMessage[0].actual.matchedMessage.data).toEqual({
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    });
});

test('createRtcProviderFromClientFactory closes client on rtc.close', async () => {
    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(fakeClient.closed).toEqual(true);
    expect(report.resultsByName.closeAlice[0].status).toEqual('SUCCESS');
    expect(report.resultsByName.closeAlice[0].actual.closed).toEqual(true);
    expect(report.rtcCloseEvents.aliceRtc.length >= 1).toEqual(true);
});

test('createRtcProviderFromClientFactory converts connect exception to RTC failure result', async () => {
    const provider = createRtcProviderFromClientFactory({
        createClient: () => {
            throw new Error('cannot create client');
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.connectAlice[0].status).toEqual('FAILURE');
    expect(report.resultsByName.connectAlice[0].result).toEqual('RTC connect failed');
    expect(report.resultsByName.connectAlice[0].actual.exception).toEqual('cannot create client');
});

test('createRtcProviderFromClientFactory converts send exception to RTC failure result', async () => {
    const fakeClient = createFakeRtcClient();
    fakeClient.send = async () => {
        throw new Error('send failed');
    };

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSends: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.aliceSends[0].status).toEqual('FAILURE');
    expect(report.resultsByName.aliceSends[0].result).toEqual('RTC send failed');
    expect(report.resultsByName.aliceSends[0].actual.exception).toEqual('send failed');
});

test('createRtcProviderFromClientFactory converts close exception to RTC failure result', async () => {
    const fakeClient = createFakeRtcClient();
    fakeClient.close = async () => {
        throw new Error('close failed');
    };

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.closeAlice[0].status).toEqual('FAILURE');
    expect(report.resultsByName.closeAlice[0].result).toEqual('RTC close failed');
    expect(report.resultsByName.closeAlice[0].actual.exception).toEqual('close failed');
});

test('createRtcProviderFromClientFactory auto-closes unclosed client connection', async () => {
    const fakeClient = createFakeRtcClient();

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(fakeClient.closed).toEqual(true);
    expect(report.rtcConnections).toEqual({});

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true);

    expect(autoCloseEvent?.autoCloseRequested).toEqual(true);
    expect(autoCloseEvent?.autoCloseSucceeded).toEqual(true);
});

test('createRtcProviderFromClientFactory records auto-close failure diagnostics', async () => {
    const fakeClient = createFakeRtcClient();
    fakeClient.close = async () => {
        throw new Error('auto close failed');
    };

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {}
                },
                connectAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                fake: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(0);
    expect(report.rtcConnections).toEqual({});

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true);

    expect(autoCloseEvent?.autoCloseRequested).toEqual(true);
    expect(autoCloseEvent?.autoCloseSucceeded).toEqual(false);
    expect(autoCloseEvent?.autoCloseFailed).toEqual(true);
    expect(autoCloseEvent?.exception).toEqual('auto close failed');
});
