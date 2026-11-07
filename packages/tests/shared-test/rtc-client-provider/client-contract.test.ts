import { expect, test } from 'bun:test';
import {
    createRallarRtcClientEventDispatcher,
    createRallarRtcClientFromOperations,
    createRallarRtcClientFromRuntime,
    decodeRallarRtcMessage,
    encodeRallarRtcMessage,
    toRallarRtcClientArgs,
    type RallarRtcClientArgs,
    type RallarRtcClientEventDispatcher
} from '../../../shared-test/black-box-runner/rallar-rtc-provider.ts';

test('createRallarRtcClientEventDispatcher emits messages to registered handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher();
    const receivedMessages: unknown[] = [];

    dispatcher.onMessage((message) => {
        receivedMessages.push(message);
    });

    dispatcher.emitMessage({
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    });

    expect(receivedMessages).toEqual([
        {
            topic: 'chat.message',
            payload: {
                text: 'hello'
            }
        }
    ]);
});

test('createRallarRtcClientEventDispatcher emits close events to registered handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher();
    const receivedCloseEvents: unknown[] = [];

    dispatcher.onClose((event) => {
        receivedCloseEvents.push(event);
    });

    dispatcher.emitClose({
        code: 1000,
        reason: 'normal close'
    });

    expect(receivedCloseEvents).toEqual([
        {
            code: 1000,
            reason: 'normal close'
        }
    ]);
});

test('createRallarRtcClientEventDispatcher supports multiple handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher();
    const firstHandlerMessages: unknown[] = [];
    const secondHandlerMessages: unknown[] = [];

    dispatcher.onMessage((message) => {
        firstHandlerMessages.push(message);
    });

    dispatcher.onMessage((message) => {
        secondHandlerMessages.push(message);
    });

    dispatcher.emitMessage({
        topic: 'presence.update'
    });

    expect(firstHandlerMessages).toEqual([
        {
            topic: 'presence.update'
        }
    ]);

    expect(secondHandlerMessages).toEqual([
        {
            topic: 'presence.update'
        }
    ]);
});

test('createRallarRtcClientFromOperations delegates connect send and close operations', async () => {
    const calls: Array<{ operation: string; args: RallarRtcClientArgs; message?: unknown; }> = [];
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
        actor: 'alice',
        roomId: 'room-1'
    });

    const client = createRallarRtcClientFromOperations(args, {
        connect: (operationArgs) => {
            calls.push({
                operation: 'connect',
                args: operationArgs
            });
        },
        send: (message, operationArgs) => {
            calls.push({
                operation: 'send',
                args: operationArgs,
                message
            });
        },
        close: (operationArgs) => {
            calls.push({
                operation: 'close',
                args: operationArgs
            });
        }
    });

    await client.connect();
    await client.send({
        topic: 'chat.message'
    });
    await client.close();

    expect(calls.map((call) => call.operation)).toEqual(['connect', 'send', 'close']);
    expect(calls[0].args.connection).toEqual('aliceRtc');
    expect(calls[1].message).toEqual({
        topic: 'chat.message'
    });
    expect(calls[2].args.roomId).toEqual('room-1');
});

test('createRallarRtcClientFromOperations exposes dispatcher to operations', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });
    const receivedMessages: unknown[] = [];
    const receivedCloseEvents: unknown[] = [];
    let connectDispatcher: RallarRtcClientEventDispatcher | undefined;
    let closeDispatcher: RallarRtcClientEventDispatcher | undefined;

    const client = createRallarRtcClientFromOperations(args, {
        connect: (_args, dispatcher) => {
            connectDispatcher = dispatcher;
            dispatcher.emitMessage({
                topic: 'connected'
            });
        },
        send: (_message, _args, dispatcher) => {
            dispatcher.emitMessage({
                topic: 'echo'
            });
        },
        close: (_args, dispatcher) => {
            closeDispatcher = dispatcher;
            dispatcher.emitClose({
                reason: 'closed by operation'
            });
        }
    });

    client.onMessage?.((message) => {
        receivedMessages.push(message);
    });

    client.onClose?.((event) => {
        receivedCloseEvents.push(event);
    });

    await client.connect();
    await client.send({
        topic: 'ping'
    });
    await client.close();

    expect(connectDispatcher !== undefined).toEqual(true);
    expect(closeDispatcher !== undefined).toEqual(true);
    expect(receivedMessages).toEqual([
        {
            topic: 'connected'
        },
        {
            topic: 'echo'
        }
    ]);
    expect(receivedCloseEvents).toEqual([
        {
            reason: 'closed by operation'
        }
    ]);
});

test('createRallarRtcClientFromOperations propagates operation failures', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromOperations(args, {
        connect: () => {
            throw new Error('connect failed');
        },
        send: () => {
            throw new Error('send failed');
        },
        close: () => {
            throw new Error('close failed');
        }
    });

    await client.connect()
        .then(() => {
            throw new Error('Expected connect to fail');
        })
        .catch((error) => {
            expect(error.message).toEqual('connect failed');
        });

    await client.send({})
        .then(() => {
            throw new Error('Expected send to fail');
        })
        .catch((error) => {
            expect(error.message).toEqual('send failed');
        });

    await client.close()
        .then(() => {
            throw new Error('Expected close to fail');
        })
        .catch((error) => {
            expect(error.message).toEqual('close failed');
        });
});

test('createRallarRtcClientFromRuntime connects and delegates to runtime session', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
        actor: 'alice',
        roomId: 'room-1'
    });
    const sentMessages: unknown[] = [];
    let runtimeConnectCalled = false;
    let sessionClosed = false;

    const client = createRallarRtcClientFromRuntime(args, {
        connect: (runtimeArgs, dispatcher) => {
            runtimeConnectCalled = true;
            dispatcher.emitMessage({
                topic: 'runtime.connected',
                connection: runtimeArgs.connection
            });

            return {
                send: (message) => {
                    sentMessages.push(message);
                },
                close: () => {
                    sessionClosed = true;
                    dispatcher.emitClose({
                        reason: 'runtime session closed'
                    });
                }
            };
        }
    });

    const receivedMessages: unknown[] = [];
    const receivedCloseEvents: unknown[] = [];

    client.onMessage?.((message) => {
        receivedMessages.push(message);
    });

    client.onClose?.((event) => {
        receivedCloseEvents.push(event);
    });

    await client.connect();
    await client.send({
        topic: 'chat.message'
    });
    await client.close();

    expect(runtimeConnectCalled).toEqual(true);
    expect(sentMessages).toEqual([
        {
            topic: 'chat.message'
        }
    ]);
    expect(sessionClosed).toEqual(true);
    expect(receivedMessages).toEqual([
        {
            topic: 'runtime.connected',
            connection: 'aliceRtc'
        }
    ]);
    expect(receivedCloseEvents).toEqual([
        {
            reason: 'runtime session closed'
        }
    ]);
});

test('createRallarRtcClientFromRuntime rejects send before connect', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromRuntime(args, {
        connect: () => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    // no-op
                }
            };
        }
    });

    await client.send({
        topic: 'chat.message'
    })
        .then(() => {
            throw new Error('Expected send before connect to fail');
        })
        .catch((error) => {
            expect(error.message).toEqual('Rallar RTC client is not connected for connection: aliceRtc');
        });
});

test('createRallarRtcClientFromRuntime close before connect is a no-op', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });
    let runtimeConnectCalled = false;

    const client = createRallarRtcClientFromRuntime(args, {
        connect: () => {
            runtimeConnectCalled = true;
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    // no-op
                }
            };
        }
    });

    await client.close();

    expect(runtimeConnectCalled).toEqual(false);
});

test('encodeRallarRtcMessage serializes object messages', () => {
    expect(encodeRallarRtcMessage({
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    })).toEqual('{"topic":"chat.message","payload":{"text":"hello"}}');
});

test('encodeRallarRtcMessage keeps string messages unchanged', () => {
    expect(encodeRallarRtcMessage('plain text')).toEqual('plain text');
});

test('encodeRallarRtcMessage fails clearly for undefined message', () => {
    try {
        encodeRallarRtcMessage(undefined);
        throw new Error('Expected undefined message encoding to fail');
    }
    catch (error) {
        expect((error as Error).message).toEqual('Rallar RTC message cannot be encoded as JSON');
    }
});

test('decodeRallarRtcMessage parses JSON strings', () => {
    expect(decodeRallarRtcMessage('{"topic":"chat.message","payload":{"text":"hello"}}')).toEqual({
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    });
});

test('decodeRallarRtcMessage keeps non-json strings unchanged', () => {
    expect(decodeRallarRtcMessage('plain text')).toEqual('plain text');
});

test('decodeRallarRtcMessage keeps non-string values unchanged', () => {
    const message = {
        topic: 'already.object'
    };

    expect(decodeRallarRtcMessage(message)).toEqual(message);
});

test('toRallarRtcClientArgs maps common RTC request fields', () => {
    const request = {
        connection: 'aliceRtc',
        provider: 'rallar-stub',
        actor: 'alice',
        peerId: 'alice-peer',
        remotePeerId: 'bob-peer',
        roomId: 'room-1',
        signaling: {
            type: 'ws',
            url: 'ws://localhost:8080/ws',
            headers: {
                Authorization: 'Bearer token'
            },
            protocol: 'rallar-signaling'
        },
        channel: {
            label: 'game-data'
        },
        rtcConfig: {
            iceServers: [
                {
                    urls: 'stun:stun.example.test'
                }
            ]
        },
        timeoutMs: 3000,
        waitForOpen: true,
        openTimeoutMs: 2000,
        metadata: {
            testRunId: 'test-run-1'
        }
    };

    const args = toRallarRtcClientArgs(request);

    expect(args.connection).toEqual('aliceRtc');
    expect(args.provider).toEqual('rallar-stub');
    expect(args.actor).toEqual('alice');
    expect(args.peerId).toEqual('alice-peer');
    expect(args.remotePeerId).toEqual('bob-peer');
    expect(args.roomId).toEqual('room-1');
    expect(args.groupId).toEqual('room-1');
    expect(args.overlayId).toEqual('room-1');
    expect(args.signalingUrl).toEqual('ws://localhost:8080/ws');
    expect(args.signalingType).toEqual('ws');
    expect(args.signalingHeaders).toEqual({
        Authorization: 'Bearer token'
    });
    expect(args.signalingProtocols).toEqual('rallar-signaling');
    expect(args.dataChannelLabel).toEqual('game-data');
    expect(args.iceServers).toEqual([
        {
            urls: 'stun:stun.example.test'
        }
    ]);
    expect(args.timeoutMs).toEqual(3000);
    expect(args.connectTimeoutMs).toEqual(3000);
    expect(args.waitForOpen).toEqual(true);
    expect(args.openTimeoutMs).toEqual(2000);
    expect(args.metadata).toEqual({
        testRunId: 'test-run-1'
    });
    expect(args.request).toEqual(request);
});

test('toRallarRtcClientArgs supports aliases and safe defaults', () => {
    const request = {
        connectionId: 'aliceRtc',
        clientId: 'alice-client',
        targetActor: 'bob',
        overlayId: 'overlay-1',
        signaling: {
            wsUrl: 'ws://localhost:8080/signaling',
            protocols: ['rallar-v1']
        },
        connectTimeoutMs: 5000
    };

    const args = toRallarRtcClientArgs(request);

    expect(args.connection).toEqual('aliceRtc');
    expect(args.provider).toEqual('rallar');
    expect(args.peerId).toEqual('alice-client');
    expect(args.remotePeerId).toEqual('bob');
    expect(args.groupId).toEqual('overlay-1');
    expect(args.overlayId).toEqual('overlay-1');
    expect(args.signalingUrl).toEqual('ws://localhost:8080/signaling');
    expect(args.signalingProtocols).toEqual(['rallar-v1']);
    expect(args.dataChannelLabel).toEqual('rallar');
    expect(args.connectTimeoutMs).toEqual(5000);
});
