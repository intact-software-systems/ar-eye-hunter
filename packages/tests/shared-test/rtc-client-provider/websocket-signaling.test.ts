import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarWebRtcSignalingOnlyProvider,
    createRallarWebRtcWebSocketSignalingFactory
} from '../../../shared-test/black-box-runner/rallar-webrtc-runtime.ts';

Deno.test('createRallarWebRtcWebSocketSignalingFactory bridges transport send message and close events', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const sentWireMessages: string[] = [];
    let transportCloseCalled = false;

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data);
            listeners.message?.forEach((listener) =>
                listener({
                    data: '{"type":"answer","from":"bob","to":"alice","sdp":"fake-answer-sdp"}'
                })
            );
        },
        close: () => {
            transportCloseCalled = true;
            listeners.close?.forEach((listener) =>
                listener({
                    code: 1000,
                    reason: 'signaling closed normally'
                })
            );
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport })
    });

    const offer = {
        type: 'offer',
        from: 'alice',
        to: 'bob',
        sdp: 'fake-offer-sdp'
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
                aliceReceivesAnswerFromTransport: {}
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
    assertEquals(sentWireMessages, [
        '{"type":"offer","from":"alice","to":"bob","sdp":"fake-offer-sdp"}'
    ]);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceReceivesAnswerFromTransport[0].status, 'SUCCESS');
    assertEquals(
        report.resultsByName.aliceReceivesAnswerFromTransport[0].actual.matchedMessage.data.actor,
        'alice'
    );
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(transportCloseCalled, true);
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory sends optional connect message after transport creation', async () => {
    const sentWireMessages: string[] = [];

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    connection: args.connection,
                    peerId: args.peerId,
                    roomId: args.roomId
                }
            })
        })
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
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"connection":"aliceRtc","peerId":"alice","roomId":"room-1"}}'
    ]);
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory can wait for transport open before connect message', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const sentWireMessages: string[] = [];

    const transport = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
                }
            })
        })
    });

    const reportPromise = executeBlackBox(
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
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    assertEquals(sentWireMessages, []);

    setTimeout(() => {
        transport.readyState = 'open';
        listeners.open?.forEach((listener) =>
            listener({
                type: 'open'
            })
        );
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}'
    ]);
    assertEquals(report.rtcMessages.aliceRtc[0].data.topic, 'rallar.webrtc.signaling.connected');
    assertEquals(report.rtcMessages.aliceRtc[0].data.opened, true);
    assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'open');
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory can use request waitForOpen settings', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const sentWireMessages: string[] = [];

    const transport = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
                }
            })
        })
    });

    const reportPromise = executeBlackBox(
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
                        waitForOpen: true,
                        openTimeoutMs: 1000,
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

    assertEquals(sentWireMessages, []);

    setTimeout(() => {
        transport.readyState = 'open';
        listeners.open?.forEach((listener) =>
            listener({
                type: 'open'
            })
        );
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}'
    ]);
    assertEquals(report.rtcMessages.aliceRtc[0].data.topic, 'rallar.webrtc.signaling.connected');
    assertEquals(report.rtcMessages.aliceRtc[0].data.opened, true);
    assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'open');
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory request waitForOpen reports timeout', async () => {
    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport })
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
                        waitForOpen: true,
                        openTimeoutMs: 50,
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
        'Rallar WebRTC signaling transport did not open within 50ms. readyState=connecting'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory uses request connectTimeoutMs for open timeout', async () => {
    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport })
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
                        waitForOpen: true,
                        connectTimeoutMs: 60,
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
        'Rallar WebRTC signaling transport did not open within 60ms. readyState=connecting'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory factory openTimeoutMs overrides request timeout', async () => {
    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport, waitForOpen: true, openTimeoutMs: 40 })
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
                        openTimeoutMs: 200,
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
        'Rallar WebRTC signaling transport did not open within 40ms. readyState=connecting'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports connect failure when transport open times out', async () => {
    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport, waitForOpen: true, openTimeoutMs: 50 })
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
        'Rallar WebRTC signaling transport did not open within 50ms. readyState=connecting'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports connect failure when transport closes before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000
        })
    });

    const reportPromise = executeBlackBox(
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
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    setTimeout(() => {
        transport.readyState = 'closed';
        listeners.close?.forEach((listener) =>
            listener({
                code: 1006,
                reason: 'closed before open'
            })
        );
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport closed before open. readyState=closed, code=1006, reason=closed before open'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports connect failure when transport errors before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000
        })
    });

    const reportPromise = executeBlackBox(
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
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    setTimeout(() => {
        transport.readyState = 'connecting';
        listeners.error?.forEach((listener) =>
            listener({
                message: 'error before open'
            })
        );
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport failed before open. readyState=connecting, message=error before open'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory skips connect message when hook returns undefined', async () => {
    const sentWireMessages: string[] = [];

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport, onConnectMessage: () => undefined })
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
    assertEquals(sentWireMessages, []);
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory supports onmessage and onclose fallback handlers', async () => {
    const sentWireMessages: string[] = [];
    let transportCloseCalled = false;

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data);
            transport.onmessage?.({
                data: '{"type":"answer","from":"bob","to":"alice"}'
            });
        },
        close: () => {
            transportCloseCalled = true;
            transport.onclose?.({
                code: 1000,
                reason: 'closed through onclose fallback'
            });
        },
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport })
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
                            peerId: 'alice',
                            roomId: 'room-1',
                            message: {
                                type: 'answer',
                                from: 'bob',
                                to: 'alice'
                            }
                        }
                    }
                },
                aliceReceivesFallbackAnswer: {}
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
    assertEquals(sentWireMessages, [
        '{"type":"offer"}'
    ]);
    assertEquals(report.resultsByName.aliceReceivesFallbackAnswer[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(transportCloseCalled, true);
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory emits close event when decode fails', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const transport = {
        send: (_data: string) => {
            listeners.message?.forEach((listener) =>
                listener({
                    data: 'bad-wire-message'
                })
            );
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            decode: () => {
                throw new Error('signaling decode failed');
            }
        })
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
                            type: 'offer'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                triggerMalformedSignalingMessage: {}
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
                            connection: 'aliceRtc',
                            peerId: 'alice',
                            roomId: 'room-1',
                            transportEvent: {
                                error: true,
                                phase: 'signaling-decode',
                                message: 'signaling decode failed'
                            }
                        }
                    }
                },
                waitForSignalingDecodeFailure: {}
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
    assertEquals(report.resultsByName.triggerMalformedSignalingMessage[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForSignalingDecodeFailure[0].status, 'SUCCESS');
    assertEquals(
        report.resultsByName.waitForSignalingDecodeFailure[0].actual.matchedCloseEvent.transportEvent.message,
        'signaling decode failed'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports send failure when encode fails', async () => {
    const transport = {
        send: (_data: string) => {
            throw new Error('transport send should not be called');
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            encode: () => {
                throw new Error('signaling encode failed');
            }
        })
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
                            type: 'offer'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsUnencodableSignalingMessage: {}
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
    assertEquals(report.resultsByName.aliceSendsUnencodableSignalingMessage[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSendsUnencodableSignalingMessage[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceSendsUnencodableSignalingMessage[0].actual.exception,
        'signaling encode failed'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports send failure when transport send fails', async () => {
    const transport = {
        send: (_data: string) => {
            throw new Error('signaling transport send failed');
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport })
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
                            type: 'offer'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsThroughFailingTransport: {}
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
    assertEquals(report.resultsByName.aliceSendsThroughFailingTransport[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSendsThroughFailingTransport[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceSendsThroughFailingTransport[0].actual.exception,
        'signaling transport send failed'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory emits close event when transport errors', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const transport = {
        send: (_data: string) => {
            listeners.error?.forEach((listener) =>
                listener({
                    message: 'signaling transport error'
                })
            );
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({ now: Date.now, createTransport: () => transport })
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
                            type: 'offer'
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                triggerSignalingTransportError: {}
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
                            connection: 'aliceRtc',
                            peerId: 'alice',
                            roomId: 'room-1',
                            transportEvent: {
                                error: true,
                                message: 'signaling transport error'
                            }
                        }
                    }
                },
                waitForSignalingTransportError: {}
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
    assertEquals(report.resultsByName.triggerSignalingTransportError[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForSignalingTransportError[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForSignalingTransportError[0].actual.matchedCloseEvent.transportEvent.error, true);
    assertEquals(
        report.resultsByName.waitForSignalingTransportError[0].actual.matchedCloseEvent.transportEvent.message,
        'signaling transport error'
    );
});

Deno.test('createRallarWebRtcWebSocketSignalingFactory preserves fallback close handler after waitForOpen', async () => {
    const sentWireMessages: string[] = [];

    const transport = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            transport.readyState = 'closed';
            transport.onclose?.({
                code: 1000,
                reason: 'closed after open'
            });
        },
        onopen: null as ((event: any) => void) | null,
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null
    };

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            now: Date.now,
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
                }
            })
        })
    });

    const reportPromise = executeBlackBox(
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
                            phase: 'signaling-close',
                            reason: 'rallar WebRTC signaling session closed',
                            connection: 'aliceRtc',
                            peerId: 'alice',
                            roomId: 'room-1',
                            transportEvent: {
                                code: 1000,
                                reason: 'closed after open'
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

    setTimeout(() => {
        transport.readyState = 'open';
        transport.onopen?.({
            type: 'open'
        });
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForSignalingClose[0].status, 'SUCCESS');
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}'
    ]);
});
