import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarInMemoryProvider } from '../../../shared-test/black-box-runner/rallar-in-memory-runtime.ts';
import { createRtcProviderFromClientFactory } from '../../../shared-test/black-box-runner/rtc-provider.ts';
import { createFakeRtcClient } from './fake-rtc-client.ts';

Deno.test('createRtcProviderFromClientFactory preserves failed send result details', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(sendResult.status, 'FAILURE');
    assertEquals(sendResult.result, 'RTC send failed');
    assertEquals(sendResult.actual.sendResult, {
        status: 'no-peers',
        peerIds: []
    });
    assertEquals(sendResult.actual.diagnostics, {
        phase: 'send',
        reason: 'no-route'
    });
    assertEquals(typeof sendResult.actual.sendLatencyMs, 'number');
});

Deno.test('RTC success status includes generic routing diagnostics', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(result.status, 'SUCCESS');
    assertEquals(result.peerId, 'alice');
    assertEquals(result.groupId, 'group-1');
    assertEquals(result.overlayId, 'overlay-1');
    assertEquals(result.remotePeerId, 'bob');
    assertEquals(result.actual.peerId, 'alice');
    assertEquals(result.actual.groupId, 'group-1');
    assertEquals(result.actual.overlayId, 'overlay-1');
    assertEquals(result.actual.remotePeerId, 'bob');
});

Deno.test('createRtcProviderFromClientFactory supports rtc.wait expect.diagnostic', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.waitForDiagnostic[0].status, 'SUCCESS');
    assertEquals(
        report.resultsByName.waitForDiagnostic[0].actual.matchedDiagnostic.topic,
        'fake.rtc.ready'
    );
    assertEquals(report.rtcDiagnostics.aliceRtc[0].topic, 'fake.rtc.ready');
    assertEquals(report.rtcMessages.aliceRtc[0].data.topic, 'fake.rtc.ready');
});

Deno.test('createRtcProviderFromClientFactory supports rtc.wait expect.health', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.waitForHealth[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForHealth[0].actual.matchedHealth, {
        ready: true,
        phase: 'ready'
    });
});

Deno.test('createRtcProviderFromClientFactory reports RTC connect, send, and first-payload latency', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(typeof connectResult.actual.connectLatencyMs, 'number');
    assertEquals(typeof sendResult.actual.sendLatencyMs, 'number');
    assertEquals(typeof sendResult.actual.firstPayloadLatencyMs, 'number');
    assertEquals(sendResult.actual.firstPayloadLatencyMs >= 0, true);
});

Deno.test('createRtcProviderFromClientFactory reports missing RTC diagnostics clearly', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(
        report.resultsByName.waitForMissingDiagnostic[0].result,
        'Expected RTC diagnostic was not received'
    );
    assertEquals(report.resultsByName.waitForMissingDiagnostic[0].actual.diagnostics, []);
});

Deno.test('createRtcProviderFromClientFactory reports missing RTC health clearly', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(
        report.resultsByName.waitForMissingHealth[0].result,
        'Expected RTC health was not observed'
    );
    assertEquals(report.resultsByName.waitForMissingHealth[0].actual.health, {
        ready: false,
        phase: 'connecting'
    });
});

Deno.test('RTC failure status includes generic routing diagnostics', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(result.status, 'FAILURE');
    assertEquals(result.peerId, 'alice');
    assertEquals(result.groupId, 'group-1');
    assertEquals(result.overlayId, 'overlay-1');
    assertEquals(result.remotePeerId, 'bob');
    assertEquals(result.actual.peerId, 'alice');
    assertEquals(result.actual.groupId, 'group-1');
    assertEquals(result.actual.overlayId, 'overlay-1');
    assertEquals(result.actual.remotePeerId, 'bob');
});

Deno.test('createRtcProviderFromClientFactory connects client and stores connection', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.connectAlice[0].actual.connected, true);
    assertEquals(fakeClient.connected, true);

    assertEquals((createdRequest as any).connection, 'aliceRtc');
    assertEquals((createdConfig as any).interactionName, 'connectAlice');
    assertEquals((createdContext as any).rtcProviders.fake !== undefined, true);
});

Deno.test('createRtcProviderFromClientFactory sends through connected client', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(fakeClient.sentMessages, [payload]);
    assertEquals(report.resultsByName.aliceSends[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSends[0].actual.sent, payload);
});

Deno.test('createRtcProviderFromClientFactory waits for client-emitted message', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.waitForMessage[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForMessage[0].actual.matchedMessage.data, {
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    });
});

Deno.test('createRtcProviderFromClientFactory closes client on rtc.close', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(fakeClient.closed, true);
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].actual.closed, true);
    assertEquals(report.rtcCloseEvents.aliceRtc.length >= 1, true);
});

Deno.test('createRtcProviderFromClientFactory converts connect exception to RTC failure result', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(report.resultsByName.connectAlice[0].actual.exception, 'cannot create client');
});

Deno.test('createRtcProviderFromClientFactory converts send exception to RTC failure result', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.aliceSends[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSends[0].result, 'RTC send failed');
    assertEquals(report.resultsByName.aliceSends[0].actual.exception, 'send failed');
});

Deno.test('createRtcProviderFromClientFactory converts close exception to RTC failure result', async () => {
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

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.closeAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.closeAlice[0].result, 'RTC close failed');
    assertEquals(report.resultsByName.closeAlice[0].actual.exception, 'close failed');
});

Deno.test('createRtcProviderFromClientFactory auto-closes unclosed client connection', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(fakeClient.closed, true);
    assertEquals(report.rtcConnections, {});

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true);

    assertEquals(autoCloseEvent?.autoCloseRequested, true);
    assertEquals(autoCloseEvent?.autoCloseSucceeded, true);
});

Deno.test('createRtcProviderFromClientFactory records auto-close failure diagnostics', async () => {
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

    assertEquals(report.summary.failure, 0);
    assertEquals(report.rtcConnections, {});

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true);

    assertEquals(autoCloseEvent?.autoCloseRequested, true);
    assertEquals(autoCloseEvent?.autoCloseSucceeded, false);
    assertEquals(autoCloseEvent?.autoCloseFailed, true);
    assertEquals(autoCloseEvent?.exception, 'auto close failed');
});
