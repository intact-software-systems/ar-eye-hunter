import { expect, test } from 'bun:test';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarWebRtcWebSocketSignalingProvider } from '../../../shared-test/black-box-runner/rallar-webrtc-runtime.ts';

test('createRallarWebRtcWebSocketSignalingProvider reports clear failure when signalingUrl is missing', async () => {
    const provider = createRallarWebRtcWebSocketSignalingProvider({ now: Date.now });

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
                connectAliceWithoutSignalingUrl: {}
            }
        ],
        0,
        {
            rtcProviders: {
                rallar: provider
            }
        }
    );

    expect(report.summary.failure).toEqual(1);
    expect(report.resultsByName.connectAliceWithoutSignalingUrl[0].status).toEqual('FAILURE');
    expect(report.resultsByName.connectAliceWithoutSignalingUrl[0].result).toEqual('RTC connect failed');
    expect(report.resultsByName.connectAliceWithoutSignalingUrl[0].actual.exception).toEqual('Rallar WebRTC signalingUrl is required for connection: aliceRtc');
});

test('createRallarWebRtcWebSocketSignalingProvider can use global WebSocket for signaling-only connect close', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const createdUrls: string[] = [];
    const sentWireMessages: string[] = [];
    const closeEvents: any[] = [];

    class FakeWebSocket {
        onmessage: ((event: any) => void) | null = null;
        onclose: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;

        constructor(url: string) {
            createdUrls.push(url);
        }

        send(data: string): void {
            sentWireMessages.push(data);
            this.onmessage?.({
                data: '{"type":"answer","from":"bob","to":"alice"}'
            });
        }

        close(): void {
            const event = {
                code: 1000,
                reason: 'fake websocket closed'
            };
            closeEvents.push(event);
            this.onclose?.(event);
        }
    }

    globalThis.WebSocket = FakeWebSocket as any;

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({ now: Date.now });

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
                                type: 'offer',
                                from: 'alice',
                                to: 'bob'
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
                    aliceReceivesFakeWebSocketAnswer: {}
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

        expect(report.summary.failure).toEqual(0);
        expect(createdUrls).toEqual(['ws://localhost:8080/ws']);
        expect(sentWireMessages).toEqual([
            '{"type":"offer","from":"alice","to":"bob"}'
        ]);
        expect(closeEvents).toEqual([
            {
                code: 1000,
                reason: 'fake websocket closed'
            }
        ]);
        expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
        expect(report.resultsByName.aliceReceivesFakeWebSocketAnswer[0].status).toEqual('SUCCESS');
        expect(report.resultsByName.closeAlice[0].status).toEqual('SUCCESS');
    }
    finally {
        globalThis.WebSocket = originalWebSocket;
    }
});

test('createRallarWebRtcWebSocketSignalingProvider supports codec and connect message hooks', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sentWireMessages: string[] = [];

    class FakeWebSocket {
        onmessage: ((event: any) => void) | null = null;
        onclose: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;

        constructor(_url: string) {
            // no-op
        }

        send(data: string): void {
            sentWireMessages.push(data);
            this.onmessage?.({
                data: 'wire:answer:bob:alice'
            });
        }

        close(): void {
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed'
            });
        }
    }

    globalThis.WebSocket = FakeWebSocket as any;

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            now: Date.now,
            encode: (message) => {
                if (message.topic === 'rallar.existing.signaling.join') {
                    return 'wire:join:' + message.payload.peerId + ':' + message.payload.roomId;
                }

                return 'wire:' + message.type + ':' + message.from + ':' + message.to;
            },
            decode: (data) => {
                const [_wire, type, from, to] = String(data).split(':');
                return {
                    type,
                    from,
                    to
                };
            },
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
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
                            signalingUrl: 'ws://localhost:8080/ws',
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
                                type: 'offer',
                                from: 'alice',
                                to: 'bob'
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
                    aliceReceivesHookDecodedAnswer: {}
                }
            ],
            0,
            {
                rtcProviders: {
                    rallar: provider
                }
            }
        );

        expect(report.summary.failure).toEqual(0);
        expect(sentWireMessages).toEqual([
            'wire:join:alice:room-1',
            'wire:offer:alice:bob'
        ]);
        expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
        expect(report.resultsByName.aliceReceivesHookDecodedAnswer[0].status).toEqual('SUCCESS');
    }
    finally {
        globalThis.WebSocket = originalWebSocket;
    }
});

test('createRallarWebRtcWebSocketSignalingProvider can wait for fake WebSocket open', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const createdSockets: FakeWebSocket[] = [];
    const sentWireMessages: string[] = [];

    class FakeWebSocket {
        readyState: string | number = 'connecting';
        onopen: ((event: any) => void) | null = null;
        onmessage: ((event: any) => void) | null = null;
        onclose: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;

        constructor(_url: string) {
            createdSockets.push(this);
        }

        send(data: string): void {
            sentWireMessages.push(data);
        }

        close(): void {
            this.readyState = 'closed';
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed'
            });
        }
    }

    globalThis.WebSocket = FakeWebSocket as any;

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            now: Date.now,
            waitForOpen: true,
            openTimeoutMs: 1000,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
                }
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
                            signalingUrl: 'ws://localhost:8080/ws',
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

        expect(sentWireMessages).toEqual([]);

        setTimeout(() => {
            const socket = createdSockets[0];
            socket.readyState = 'open';
            socket.onopen?.({
                type: 'open'
            });
        }, 25);

        const report = await reportPromise;

        expect(report.summary.failure).toEqual(0);
        expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
        expect(sentWireMessages).toEqual([
            '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}'
        ]);
        expect(report.rtcMessages.aliceRtc[0].data.topic).toEqual('rallar.webrtc.signaling.connected');
        expect(report.rtcMessages.aliceRtc[0].data.opened).toEqual(true);
        expect(report.rtcMessages.aliceRtc[0].data.readyState).toEqual('open');
    }
    finally {
        globalThis.WebSocket = originalWebSocket;
    }
});

test('createRallarWebRtcWebSocketSignalingProvider waits for fake WebSocket open by default', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const createdSockets: FakeWebSocket[] = [];
    const sentWireMessages: string[] = [];

    class FakeWebSocket {
        readyState: string | number = 'connecting';
        onopen: ((event: any) => void) | null = null;
        onmessage: ((event: any) => void) | null = null;
        onclose: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;

        constructor(_url: string) {
            createdSockets.push(this);
        }

        send(data: string): void {
            sentWireMessages.push(data);
        }

        close(): void {
            this.readyState = 'closed';
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed'
            });
        }
    }

    globalThis.WebSocket = FakeWebSocket as any;

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            now: Date.now,
            openTimeoutMs: 1000,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
                }
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
                            signalingUrl: 'ws://localhost:8080/ws',
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

        expect(sentWireMessages).toEqual([]);

        setTimeout(() => {
            const socket = createdSockets[0];
            socket.readyState = 'open';
            socket.onopen?.({
                type: 'open'
            });
        }, 25);

        const report = await reportPromise;

        expect(report.summary.failure).toEqual(0);
        expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
        expect(sentWireMessages).toEqual([
            '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}'
        ]);
        expect(report.rtcMessages.aliceRtc[0].data.opened).toEqual(true);
        expect(report.rtcMessages.aliceRtc[0].data.readyState).toEqual('open');
    }
    finally {
        globalThis.WebSocket = originalWebSocket;
    }
});

test('createRallarWebRtcWebSocketSignalingProvider can disable default waitForOpen', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sentWireMessages: string[] = [];

    class FakeWebSocket {
        readyState: string | number = 'connecting';
        onopen: ((event: any) => void) | null = null;
        onmessage: ((event: any) => void) | null = null;
        onclose: ((event: any) => void) | null = null;
        onerror: ((event: any) => void) | null = null;

        constructor(_url: string) {
            // no-op
        }

        send(data: string): void {
            sentWireMessages.push(data);
        }

        close(): void {
            this.readyState = 'closed';
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed'
            });
        }
    }

    globalThis.WebSocket = FakeWebSocket as any;

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            now: Date.now,
            waitForOpen: false,
            onConnectMessage: (args) => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId
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
                            signalingUrl: 'ws://localhost:8080/ws',
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

        expect(report.summary.failure).toEqual(0);
        expect(report.resultsByName.connectAlice[0].status).toEqual('SUCCESS');
        expect(sentWireMessages).toEqual([
            '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}'
        ]);
        expect(report.rtcMessages.aliceRtc[0].data.opened).toEqual(false);
        expect(report.rtcMessages.aliceRtc[0].data.readyState).toEqual('connecting');
    }
    finally {
        globalThis.WebSocket = originalWebSocket;
    }
});
