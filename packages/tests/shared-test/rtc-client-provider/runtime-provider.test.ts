import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarRtcClientEventDispatcher,
    createRallarRtcClientFromOperations,
    createRallarRtcProvider,
    createRallarRtcProviderFromRuntime,
    toRallarRtcClientArgs
} from '../../../shared-test/black-box-runner/rallar-rtc-provider.ts';
import {
    createRallarWebRtcProvider,
    createRallarWebRtcRuntime,
    createRallarWebRtcSignalingOnlyProvider
} from '../../../shared-test/black-box-runner/rallar-webrtc-runtime.ts';
import { createFakeRtcClient } from './fake-rtc-client.ts';

Deno.test('createRallarRtcProvider maps request to Rallar client factory args', async () => {
    const fakeClient = createFakeRtcClient();
    let capturedArgs: any;
    let capturedConfig: any;
    let capturedContext: any;

    const provider = createRallarRtcProvider({
        createClient: (args, config, context) => {
            capturedArgs = args;
            capturedConfig = config;
            capturedContext = context;
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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        signaling: {
                            type: 'ws',
                            url: 'ws://localhost:8080/ws'
                        },
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
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(fakeClient.connected, true);
    assertEquals(capturedArgs.connection, 'aliceRtc');
    assertEquals(capturedArgs.provider, 'rallar');
    assertEquals(capturedArgs.actor, 'alice');
    assertEquals(capturedArgs.peerId, 'alice');
    assertEquals(capturedArgs.roomId, 'room-1');
    assertEquals(capturedArgs.groupId, 'room-1');
    assertEquals(capturedArgs.signalingUrl, 'ws://localhost:8080/ws');
    assertEquals(capturedArgs.signalingType, 'ws');
    assertEquals(capturedConfig.interactionName, 'connectAlice');
    assertEquals(capturedContext.rtcProviders.rallar !== undefined, true);
});

Deno.test('createRallarRtcProvider supports operations-based Rallar client messages', async () => {
    const provider = createRallarRtcProvider({
        createClient: (args) => {
            return createRallarRtcClientFromOperations(args, {
                connect: () => {
                    // no-op for fake operations client
                },
                send: (message, _args, dispatcher) => {
                    dispatcher.emitMessage(message);
                },
                close: (_args, dispatcher) => {
                    dispatcher.emitClose({
                        reason: 'closed by operations client'
                    });
                }
            });
        }
    });

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello from operations client'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload
                    }
                },
                aliceSendsAndReceivesEcho: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                closeAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload);
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.rtcCloseEvents.aliceRtc.length >= 1, true);
});

Deno.test('createRallarWebRtcRuntime fails clearly when createSession is missing', async () => {
    const runtime = createRallarWebRtcRuntime();
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    try {
        await runtime.connect(args, createRallarRtcClientEventDispatcher());
        throw new Error('Expected runtime connect to fail');
    }
    catch (error) {
        assertEquals(
            (error as Error).message,
            'Rallar WebRTC runtime is not implemented yet. Missing createSession implementation for connection: aliceRtc'
        );
    }
});

Deno.test('createRallarWebRtcProvider reports clear connect failure when createSession is missing', async () => {
    const provider = createRallarWebRtcProvider();

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC runtime is not implemented yet. Missing createSession implementation for connection: aliceRtc'
    );
});

Deno.test('createRallarWebRtcProvider can execute scenario through injected createSession', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: (_args, dispatcher) => {
            return {
                send: (message) => {
                    dispatcher.emitMessage(message);
                },
                close: () => {
                    dispatcher.emitClose({
                        phase: 'close',
                        reason: 'closed by injected WebRTC session'
                    });
                }
            };
        }
    });

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through injected WebRTC session'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload
                    }
                },
                aliceSendsAndReceivesEcho: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                closeAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload);
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
});

Deno.test('createRallarWebRtcSignalingOnlyProvider can connect and close signaling session', async () => {
    const signalingEvents: unknown[] = [];

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: (args) => {
                signalingEvents.push({
                    type: 'connect',
                    connection: args.connection,
                    peerId: args.peerId,
                    roomId: args.roomId,
                    signalingUrl: args.signalingUrl
                });

                return {
                    close: () => {
                        signalingEvents.push({
                            type: 'close',
                            connection: args.connection
                        });
                    }
                };
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        signalingUrl: 'ws://localhost:8080/ws',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: {
                            topic: 'rallar.webrtc.signaling.connected',
                            connection: 'aliceRtc',
                            peerId: 'alice',
                            roomId: 'room-1',
                            signalingUrl: 'ws://localhost:8080/ws'
                        }
                    }
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'closed by rallar WebRTC signaling-only runtime',
                            closedBy: 'rallar-webrtc-signaling-only-runtime',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1'
                        }
                    }
                },
                waitForAliceClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS');
    assertEquals(report.rtcMessages.aliceRtc[0].data.actor, 'alice');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy, 'rallar-webrtc-signaling-only-runtime');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.actor, 'alice');
    assertEquals(signalingEvents, [
        {
            type: 'connect',
            connection: 'aliceRtc',
            peerId: 'alice',
            roomId: 'room-1',
            signalingUrl: 'ws://localhost:8080/ws'
        },
        {
            type: 'close',
            connection: 'aliceRtc'
        }
    ]);
});

Deno.test('createRallarWebRtcSignalingOnlyProvider emits group and overlay diagnostics', async () => {
    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    close: () => {
                        // no-op
                    }
                };
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: {
                            topic: 'rallar.webrtc.signaling.connected',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            groupId: 'group-1',
                            overlayId: 'overlay-1'
                        }
                    }
                },
                connectAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'closed by rallar WebRTC signaling-only runtime',
                            closedBy: 'rallar-webrtc-signaling-only-runtime',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            groupId: 'group-1',
                            overlayId: 'overlay-1'
                        }
                    }
                },
                waitForAliceClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS');
    assertEquals(report.rtcMessages.aliceRtc[0].data.groupId, 'group-1');
    assertEquals(report.rtcMessages.aliceRtc[0].data.overlayId, 'overlay-1');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId, 'group-1');
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId, 'overlay-1');
});

Deno.test('createRallarWebRtcSignalingOnlyProvider reports send failure when data channel is missing', async () => {
    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    close: () => {
                        // no-op
                    }
                };
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsWithoutDataChannel: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsWithoutDataChannel[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSendsWithoutDataChannel[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceSendsWithoutDataChannel[0].actual.exception,
        'Rallar WebRTC data channel is not implemented yet. Signaling-only runtime cannot send RTC payload for connection: aliceRtc'
    );
});

Deno.test('createRallarWebRtcSignalingOnlyProvider delegates send to signaling session when available', async () => {
    const signalingEvents: unknown[] = [];

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: (args) => {
                signalingEvents.push({
                    type: 'connect',
                    connection: args.connection,
                    peerId: args.peerId,
                    roomId: args.roomId
                });

                return {
                    send: (message) => {
                        signalingEvents.push({
                            type: 'send',
                            connection: args.connection,
                            message
                        });
                    },
                    close: () => {
                        signalingEvents.push({
                            type: 'close',
                            connection: args.connection
                        });
                    }
                };
            }
        }
    });

    const signalingMessage = {
        topic: 'rallar.webrtc.signaling.offer',
        payload: {
            from: 'alice',
            to: 'bob',
            sdp: 'fake-offer-sdp'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: signalingMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsSignalingOffer: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                closeAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsSignalingOffer[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(signalingEvents, [
        {
            type: 'connect',
            connection: 'aliceRtc',
            peerId: 'alice',
            roomId: 'room-1'
        },
        {
            type: 'send',
            connection: 'aliceRtc',
            message: signalingMessage
        },
        {
            type: 'close',
            connection: 'aliceRtc'
        }
    ]);
});

Deno.test('createRallarWebRtcSignalingOnlyProvider forwards incoming signaling messages', async () => {
    const signalingMessageHandlers: Array<(message: any) => void> = [];

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    send: () => {
                        signalingMessageHandlers.forEach((handler) =>
                            handler({
                                type: 'answer',
                                from: 'bob',
                                to: 'alice',
                                sdp: 'fake-answer-sdp'
                            })
                        );
                    },
                    close: () => {
                        // no-op
                    },
                    onMessage: (handler) => {
                        signalingMessageHandlers.push(handler);
                    }
                };
            }
        }
    });

    const offer = {
        topic: 'rallar.webrtc.signaling.offer',
        payload: {
            from: 'alice',
            to: 'bob',
            sdp: 'fake-offer-sdp'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: offer,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: {
                            topic: 'rallar.webrtc.signaling.message',
                            connection: 'aliceRtc',
                            peerId: 'alice',
                            roomId: 'room-1',
                            message: {
                                type: 'answer',
                                from: 'bob',
                                to: 'alice',
                                sdp: 'fake-answer-sdp'
                            }
                        }
                    }
                },
                aliceReceivesSignalingAnswer: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].status, 'SUCCESS');
    assertEquals(report.rtcMessages.aliceRtc[0].data.actor, 'alice');
});

Deno.test('createRallarWebRtcSignalingOnlyProvider forwards group and overlay on incoming signaling messages', async () => {
    const signalingMessageHandlers: Array<(message: any) => void> = [];

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    send: () => {
                        signalingMessageHandlers.forEach((handler) =>
                            handler({
                                type: 'answer',
                                from: 'bob',
                                to: 'alice'
                            })
                        );
                    },
                    close: () => {
                        // no-op
                    },
                    onMessage: (handler) => {
                        signalingMessageHandlers.push(handler);
                    }
                };
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        send: {
                            type: 'offer'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: {
                            topic: 'rallar.webrtc.signaling.message',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            groupId: 'group-1',
                            overlayId: 'overlay-1',
                            message: {
                                type: 'answer',
                                from: 'bob',
                                to: 'alice'
                            }
                        }
                    }
                },
                aliceReceivesSignalingAnswer: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].actual.matchedMessage.data.groupId, 'group-1');
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].actual.matchedMessage.data.overlayId, 'overlay-1');
});

Deno.test('createRallarWebRtcSignalingOnlyProvider forwards signaling close events', async () => {
    const signalingCloseHandlers: Array<(event: any) => void> = [];

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    send: () => {
                        signalingCloseHandlers.forEach((handler) =>
                            handler({
                                code: 1006,
                                reason: 'signaling transport closed'
                            })
                        );
                    },
                    close: () => {
                        // no-op
                    },
                    onClose: (handler) => {
                        signalingCloseHandlers.push(handler);
                    }
                };
            }
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'rallar.webrtc.signaling.ping'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                triggerSignalingClose: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'signaling-close',
                            reason: 'rallar WebRTC signaling session closed',
                            closedBy: 'rallar-webrtc-signaling-only-runtime',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            transportEvent: {
                                code: 1006,
                                reason: 'signaling transport closed'
                            }
                        }
                    }
                },
                waitForSignalingClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.triggerSignalingClose[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForSignalingClose[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.closedBy, 'rallar-webrtc-signaling-only-runtime');
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.actor, 'alice');
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.transportEvent.code, 1006);
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.transportEvent.reason, 'signaling transport closed');
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.event.transportEvent.code, 1006);
    assertEquals(report.rtcMessages.aliceRtc[0].data.actor, 'alice');
});

Deno.test('createRallarRtcProviderFromRuntime supports scenario execution through runtime session', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: (message) => {
                    dispatcher.emitMessage(message);
                },
                close: () => {
                    dispatcher.emitClose({
                        reason: 'closed by runtime provider'
                    });
                }
            };
        }
    });

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through runtime provider'
        }
    };

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload
                    }
                },
                aliceSendsAndReceivesEcho: {}
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {}
                },
                closeAlice: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload);
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
});

Deno.test('createRallarRtcProviderFromRuntime supports ordered expect.messages from runtime session', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: () => {
                    dispatcher.emitMessage({
                        topic: 'room.member.joined',
                        payload: {
                            actor: 'alice'
                        }
                    });
                    dispatcher.emitMessage({
                        topic: 'presence.update',
                        payload: {
                            actor: 'alice',
                            online: true
                        }
                    });
                },
                close: () => {
                    dispatcher.emitClose({
                        reason: 'closed by runtime provider'
                    });
                }
            };
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'trigger.join.flow'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        ordered: true,
                        consume: true,
                        messages: [
                            {
                                topic: 'room.member.joined'
                            },
                            {
                                topic: 'presence.update'
                            }
                        ]
                    }
                },
                aliceReceivesOrderedRuntimeMessages: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].actual.ordered, true);
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].actual.consumed, true);
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].actual.matchedMessages.length, 2);
});

Deno.test('createRallarRtcProviderFromRuntime supports rtc.wait expect.close from runtime session', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    dispatcher.emitClose({
                        reason: 'closed by runtime provider'
                    });
                }
            };
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                closeAlice: {}
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            event: {
                                reason: 'closed by runtime provider'
                            }
                        }
                    }
                },
                waitForRuntimeClose: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForRuntimeClose[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForRuntimeClose[0].actual.matchedCloseEvent.event.reason, 'closed by runtime provider');
});

Deno.test('createRallarRtcProviderFromRuntime reports runtime connect failure through scenario result', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: () => {
            throw new Error('runtime connect failed');
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(report.resultsByName.connectAlice[0].actual.exception, 'runtime connect failed');
});

Deno.test('createRallarRtcProviderFromRuntime reports runtime send failure through scenario result', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: () => {
            return {
                send: () => {
                    throw new Error('runtime send failed');
                },
                close: () => {
                    // no-op
                }
            };
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
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
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.aliceSends[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSends[0].result, 'RTC send failed');
    assertEquals(report.resultsByName.aliceSends[0].actual.exception, 'runtime send failed');
});

Deno.test('createRallarRtcProviderFromRuntime reports runtime close failure through scenario result', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: () => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    throw new Error('runtime close failed');
                }
            };
        }
    });

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtc',
                        provider: 'rallar',
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
                        provider: 'rallar',
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
                rallar: provider
            }
        }
    );

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.closeAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.closeAlice[0].result, 'RTC close failed');
    assertEquals(report.resultsByName.closeAlice[0].actual.exception, 'runtime close failed');
});
