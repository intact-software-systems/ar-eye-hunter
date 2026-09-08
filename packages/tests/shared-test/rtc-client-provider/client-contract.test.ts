import { assertEquals } from '@std/assert';
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

Deno.test('createRallarRtcClientEventDispatcher emits messages to registered handlers', () => {
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

    assertEquals(receivedMessages, [
        {
            topic: 'chat.message',
            payload: {
                text: 'hello'
            }
        }
    ]);
});

Deno.test('createRallarRtcClientEventDispatcher emits close events to registered handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher();
    const receivedCloseEvents: unknown[] = [];

    dispatcher.onClose((event) => {
        receivedCloseEvents.push(event);
    });

    dispatcher.emitClose({
        code: 1000,
        reason: 'normal close'
    });

    assertEquals(receivedCloseEvents, [
        {
            code: 1000,
            reason: 'normal close'
        }
    ]);
});

Deno.test('createRallarRtcClientEventDispatcher supports multiple handlers', () => {
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

    assertEquals(firstHandlerMessages, [
        {
            topic: 'presence.update'
        }
    ]);

    assertEquals(secondHandlerMessages, [
        {
            topic: 'presence.update'
        }
    ]);
});

Deno.test('createRallarRtcClientFromOperations delegates connect send and close operations', async () => {
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

    assertEquals(calls.map((call) => call.operation), ['connect', 'send', 'close']);
    assertEquals(calls[0].args.connection, 'aliceRtc');
    assertEquals(calls[1].message, {
        topic: 'chat.message'
    });
    assertEquals(calls[2].args.roomId, 'room-1');
});

Deno.test('createRallarRtcClientFromOperations exposes dispatcher to operations', async () => {
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

    assertEquals(connectDispatcher !== undefined, true);
    assertEquals(closeDispatcher !== undefined, true);
    assertEquals(receivedMessages, [
        {
            topic: 'connected'
        },
        {
            topic: 'echo'
        }
    ]);
    assertEquals(receivedCloseEvents, [
        {
            reason: 'closed by operation'
        }
    ]);
});

Deno.test('createRallarRtcClientFromOperations propagates operation failures', async () => {
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
            assertEquals(error.message, 'connect failed');
        });

    await client.send({})
        .then(() => {
            throw new Error('Expected send to fail');
        })
        .catch((error) => {
            assertEquals(error.message, 'send failed');
        });

    await client.close()
        .then(() => {
            throw new Error('Expected close to fail');
        })
        .catch((error) => {
            assertEquals(error.message, 'close failed');
        });
});

Deno.test('createRallarRtcClientFromRuntime connects and delegates to runtime session', async () => {
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

    assertEquals(runtimeConnectCalled, true);
    assertEquals(sentMessages, [
        {
            topic: 'chat.message'
        }
    ]);
    assertEquals(sessionClosed, true);
    assertEquals(receivedMessages, [
        {
            topic: 'runtime.connected',
            connection: 'aliceRtc'
        }
    ]);
    assertEquals(receivedCloseEvents, [
        {
            reason: 'runtime session closed'
        }
    ]);
});

Deno.test('createRallarRtcClientFromRuntime rejects send before connect', async () => {
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
            assertEquals(
                error.message,
                'Rallar RTC client is not connected for connection: aliceRtc'
            );
        });
});

Deno.test('createRallarRtcClientFromRuntime close before connect is a no-op', async () => {
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

    assertEquals(runtimeConnectCalled, false);
});

Deno.test('encodeRallarRtcMessage serializes object messages', () => {
    assertEquals(
        encodeRallarRtcMessage({
            topic: 'chat.message',
            payload: {
                text: 'hello'
            }
        }),
        '{"topic":"chat.message","payload":{"text":"hello"}}'
    );
});

Deno.test('encodeRallarRtcMessage keeps string messages unchanged', () => {
    assertEquals(encodeRallarRtcMessage('plain text'), 'plain text');
});

Deno.test('encodeRallarRtcMessage fails clearly for undefined message', () => {
    try {
        encodeRallarRtcMessage(undefined);
        throw new Error('Expected undefined message encoding to fail');
    }
    catch (error) {
        assertEquals((error as Error).message, 'Rallar RTC message cannot be encoded as JSON');
    }
});

Deno.test('decodeRallarRtcMessage parses JSON strings', () => {
    assertEquals(
        decodeRallarRtcMessage('{"topic":"chat.message","payload":{"text":"hello"}}'),
        {
            topic: 'chat.message',
            payload: {
                text: 'hello'
            }
        }
    );
});

Deno.test('decodeRallarRtcMessage keeps non-json strings unchanged', () => {
    assertEquals(decodeRallarRtcMessage('plain text'), 'plain text');
});

Deno.test('decodeRallarRtcMessage keeps non-string values unchanged', () => {
    const message = {
        topic: 'already.object'
    };

    assertEquals(decodeRallarRtcMessage(message), message);
});

Deno.test('toRallarRtcClientArgs maps common RTC request fields', () => {
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

    assertEquals(args.connection, 'aliceRtc');
    assertEquals(args.provider, 'rallar-stub');
    assertEquals(args.actor, 'alice');
    assertEquals(args.peerId, 'alice-peer');
    assertEquals(args.remotePeerId, 'bob-peer');
    assertEquals(args.roomId, 'room-1');
    assertEquals(args.groupId, 'room-1');
    assertEquals(args.overlayId, 'room-1');
    assertEquals(args.signalingUrl, 'ws://localhost:8080/ws');
    assertEquals(args.signalingType, 'ws');
    assertEquals(args.signalingHeaders, {
        Authorization: 'Bearer token'
    });
    assertEquals(args.signalingProtocols, 'rallar-signaling');
    assertEquals(args.dataChannelLabel, 'game-data');
    assertEquals(args.iceServers, [
        {
            urls: 'stun:stun.example.test'
        }
    ]);
    assertEquals(args.timeoutMs, 3000);
    assertEquals(args.connectTimeoutMs, 3000);
    assertEquals(args.waitForOpen, true);
    assertEquals(args.openTimeoutMs, 2000);
    assertEquals(args.metadata, {
        testRunId: 'test-run-1'
    });
    assertEquals(args.request, request);
});

Deno.test('toRallarRtcClientArgs supports aliases and safe defaults', () => {
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

    assertEquals(args.connection, 'aliceRtc');
    assertEquals(args.provider, 'rallar');
    assertEquals(args.peerId, 'alice-client');
    assertEquals(args.remotePeerId, 'bob');
    assertEquals(args.groupId, 'overlay-1');
    assertEquals(args.overlayId, 'overlay-1');
    assertEquals(args.signalingUrl, 'ws://localhost:8080/signaling');
    assertEquals(args.signalingProtocols, ['rallar-v1']);
    assertEquals(args.dataChannelLabel, 'rallar');
    assertEquals(args.connectTimeoutMs, 5000);
});
