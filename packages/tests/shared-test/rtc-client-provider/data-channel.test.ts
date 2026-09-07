import { assertEquals } from '@std/assert';
import { executeBlackBox } from '../../../shared-test/black-box-runner/execute-black-box.ts';
import {
    createRallarRtcClientFromRuntime,
    createRallarRtcProviderFromDataChannelFactory,
    createRallarRtcProviderFromRuntime,
    createRallarRtcRuntimeFromDataChannelFactory,
    toRallarRtcClientArgs,
    type RallarRtcMessageCodec
} from '../../../shared-test/black-box-runner/rallar-rtc-provider.ts';

Deno.test('createRallarRtcRuntimeFromDataChannelFactory sends encoded messages and decodes received messages', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const sentWireMessages: string[] = [];
    let closeCalled = false;

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            closeCalled = true;
            listeners.close?.forEach((listener) =>
                listener({
                    code: 1000,
                    reason: 'normal close'
                })
            );
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromRuntime(args, runtime);
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
        topic: 'chat.message',
        payload: {
            text: 'hello'
        }
    });

    listeners.message.forEach((listener) =>
        listener({
            data: '{"topic":"chat.message","payload":{"text":"from wire"}}'
        })
    );

    await client.close();

    assertEquals(sentWireMessages, [
        '{"topic":"chat.message","payload":{"text":"hello"}}'
    ]);

    assertEquals(receivedMessages, [
        {
            topic: 'chat.message',
            payload: {
                text: 'from wire'
            }
        }
    ]);

    assertEquals(closeCalled, true);
    assertEquals((receivedCloseEvents[0] as any).reason, 'normal close');
    assertEquals((receivedCloseEvents[0] as any).code, 1000);
    assertEquals((receivedCloseEvents[0] as any).phase, 'close');
});

Deno.test('createRallarRtcRuntimeFromDataChannelFactory supports onmessage and onclose fallback handlers', async () => {
    const sentWireMessages: string[] = [];
    let closeCalled = false;

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            closeCalled = true;
            dataChannel.onclose?.({
                code: 1000,
                reason: 'closed through onclose fallback'
            });
        },
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null
    };

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromRuntime(args, runtime);
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

    dataChannel.onmessage?.({
        data: '{"topic":"fallback.message"}'
    });

    await client.close();

    assertEquals(sentWireMessages, [
        '{"topic":"chat.message"}'
    ]);

    assertEquals(receivedMessages, [
        {
            topic: 'fallback.message'
        }
    ]);

    assertEquals(closeCalled, true);
    assertEquals((receivedCloseEvents[0] as any).reason, 'closed through onclose fallback');
    assertEquals((receivedCloseEvents[0] as any).code, 1000);
    assertEquals((receivedCloseEvents[0] as any).phase, 'close');
});

Deno.test('createRallarRtcRuntimeFromDataChannelFactory maps data channel error to close event', async () => {
    const dataChannel = {
        readyState: 'closing',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null
    };

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromRuntime(args, runtime);
    const receivedCloseEvents: unknown[] = [];

    client.onClose?.((event) => {
        receivedCloseEvents.push(event);
    });

    await client.connect();

    dataChannel.onerror?.({
        message: 'data channel error'
    });

    assertEquals(receivedCloseEvents, [
        {
            event: {
                message: 'data channel error'
            },
            error: true,
            phase: 'error',
            message: 'data channel error',
            readyState: 'closing'
        }
    ]);
});

Deno.test('createRallarRtcProviderFromDataChannelFactory supports scenario execution through data channel', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const sentWireMessages: string[] = [];

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data);
            listeners.message?.forEach((listener) =>
                listener({
                    data
                })
            );
        },
        close: () => {
            listeners.close?.forEach((listener) =>
                listener({
                    code: 1000,
                    reason: 'closed by provider data channel'
                })
            );
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || [];
            listeners[type].push(listener);
        }
    };

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through data channel provider'
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
    assertEquals(sentWireMessages, [
        '{"topic":"chat.message","payload":{"text":"hello through data channel provider"}}'
    ]);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload);
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
});

Deno.test('createRallarRtcProviderFromDataChannelFactory supports custom wire message codec', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const sentWireMessages: string[] = [];

    const codec: RallarRtcMessageCodec = {
        encode: (message) => 'wire:' + JSON.stringify(message),
        decode: (data) => {
            const wireData = String(data);
            return JSON.parse(wireData.substring('wire:'.length));
        }
    };

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data);
            listeners.message?.forEach((listener) =>
                listener({
                    data
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

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, codec, connect: () => dataChannel });

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through custom codec'
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
                aliceSendsAndReceivesCustomCodecEcho: {}
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
        'wire:{"topic":"chat.message","payload":{"text":"hello through custom codec"}}'
    ]);
    assertEquals(report.resultsByName.aliceSendsAndReceivesCustomCodecEcho[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAndReceivesCustomCodecEcho[0].actual.matchedMessage.data, payload);
});

Deno.test('createRallarRtcProviderFromDataChannelFactory records close event when custom decode fails', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const dataChannel = {
        readyState: 'open',
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

    const provider = createRallarRtcProviderFromDataChannelFactory({
        now: Date.now,
        codec: {
            decode: () => {
                throw new Error('custom decode failed');
            }
        },
        connect: () => dataChannel
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
                aliceSendsBadWireMessage: {}
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
    assertEquals(report.resultsByName.aliceSendsBadWireMessage[0].status, 'SUCCESS');
    assertEquals(report.rtcCloseEvents.aliceRtc[0].error, true);
    assertEquals(report.rtcCloseEvents.aliceRtc[0].phase, 'decode');
    assertEquals(report.rtcCloseEvents.aliceRtc[0].message, 'custom decode failed');
    assertEquals(report.rtcCloseEvents.aliceRtc[0].readyState, 'open');
    assertEquals(report.rtcCloseEvents.aliceRtc[0].event.error, true);
});

Deno.test('createRallarRtcProviderFromRuntime supports rtc.wait expect.close with flattened close fields', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    dispatcher.emitClose({
                        phase: 'close',
                        reason: 'closed by flattened runtime provider'
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
                            phase: 'close',
                            reason: 'closed by flattened runtime provider'
                        }
                    }
                },
                waitForFlattenedRuntimeClose: {}
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
    assertEquals(report.resultsByName.waitForFlattenedRuntimeClose[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForFlattenedRuntimeClose[0].actual.matchedCloseEvent.phase, 'close');
    assertEquals(
        report.resultsByName.waitForFlattenedRuntimeClose[0].actual.matchedCloseEvent.event.reason,
        'closed by flattened runtime provider'
    );
});

Deno.test('createRallarRtcProviderFromDataChannelFactory reports failure when data channel is not open', async () => {
    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            throw new Error('send should not be called while connecting');
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

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
                aliceSendsTooEarly: {}
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
    assertEquals(report.resultsByName.aliceSendsTooEarly[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSendsTooEarly[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceSendsTooEarly[0].actual.exception,
        'Rallar RTC data channel is not open. readyState=connecting'
    );
});

Deno.test('createRallarRtcProviderFromDataChannelFactory reports failure when message cannot be encoded', async () => {
    const dataChannel = {
        readyState: 'open',
        send: (_data: string) => {
            throw new Error('send should not be called when encoding fails');
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        }
    };

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

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
                        send: undefined,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsUndefined: {}
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
    assertEquals(report.resultsByName.aliceSendsUndefined[0].status, 'FAILURE');
    assertEquals(report.resultsByName.aliceSendsUndefined[0].result, 'RTC send failed');
    assertEquals(
        report.resultsByName.aliceSendsUndefined[0].actual.exception,
        'Rallar RTC message cannot be encoded as JSON'
    );
});

Deno.test('createRallarRtcRuntimeFromDataChannelFactory can wait for data channel open during connect', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const dataChannel = {
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

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({ now: Date.now, waitForOpen: true, openTimeoutMs: 1000, connect: () => dataChannel });

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromRuntime(args, runtime);

    const connectPromise = client.connect();

    setTimeout(() => {
        dataChannel.readyState = 'open';
        listeners.open?.forEach((listener) =>
            listener({
                type: 'open'
            })
        );
    }, 25);

    await connectPromise;

    assertEquals(dataChannel.readyState, 'open');
});

Deno.test('createRallarRtcProviderFromDataChannelFactory reports connect failure when data channel open times out', async () => {
    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op; never emits open
        }
    };

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, waitForOpen: true, openTimeoutMs: 50, connect: () => dataChannel });

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
        'Rallar RTC data channel did not open within 50ms. readyState=connecting'
    );
});

Deno.test('createRallarRtcProviderFromDataChannelFactory reports connect failure when data channel closes before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const dataChannel = {
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

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, waitForOpen: true, openTimeoutMs: 1000, connect: () => dataChannel });

    const reportPromise = executeBlackBox(
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

    setTimeout(() => {
        dataChannel.readyState = 'closed';
        listeners.close?.forEach((listener) =>
            listener({
                code: 1006,
                reason: 'closed while connecting'
            })
        );
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar RTC data channel closed before open. readyState=closed, code=1006, reason=closed while connecting'
    );
});

Deno.test('createRallarRtcProviderFromDataChannelFactory reports connect failure when data channel errors before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const dataChannel = {
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

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, waitForOpen: true, openTimeoutMs: 1000, connect: () => dataChannel });

    const reportPromise = executeBlackBox(
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

    setTimeout(() => {
        dataChannel.readyState = 'closing';
        listeners.error?.forEach((listener) =>
            listener({
                message: 'ICE failed while connecting'
            })
        );
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 1);
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE');
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed');
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar RTC data channel failed before open. readyState=closing, message=ICE failed while connecting'
    );
});

Deno.test('createRallarRtcRuntimeFromDataChannelFactory can wait for data channel onopen fallback during connect', async () => {
    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        onopen: null as ((event: any) => void) | null,
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null
    };

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({ now: Date.now, waitForOpen: true, openTimeoutMs: 1000, connect: () => dataChannel });

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar'
    });

    const client = createRallarRtcClientFromRuntime(args, runtime);
    const connectPromise = client.connect();

    setTimeout(() => {
        dataChannel.readyState = 'open';
        dataChannel.onopen?.({
            type: 'open'
        });
    }, 25);

    await connectPromise;

    assertEquals(dataChannel.readyState, 'open');
});

Deno.test('createRallarRtcRuntimeFromDataChannelFactory can use request waitForOpen settings', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {};

    const dataChannel = {
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

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({ now: Date.now, connect: () => dataChannel });

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
        waitForOpen: true,
        openTimeoutMs: 1000
    });

    const client = createRallarRtcClientFromRuntime(args, runtime);
    const connectPromise = client.connect();

    setTimeout(() => {
        dataChannel.readyState = 'open';
        listeners.open?.forEach((listener) =>
            listener({
                type: 'open'
            })
        );
    }, 25);

    await connectPromise;

    assertEquals(dataChannel.readyState, 'open');
});

Deno.test('createRallarRtcProviderFromDataChannelFactory preserves fallback close handler after waitForOpen', async () => {
    const sentWireMessages: string[] = [];

    const dataChannel = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data);
        },
        close: () => {
            dataChannel.readyState = 'closed';
            dataChannel.onclose?.({
                code: 1000,
                reason: 'data channel closed after open'
            });
        },
        onopen: null as ((event: any) => void) | null,
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null
    };

    const provider = createRallarRtcProviderFromDataChannelFactory({ now: Date.now, connect: () => dataChannel, waitForOpen: true, openTimeoutMs: 1000 });

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
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello after open'
                            }
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2
                    },
                    response: {}
                },
                aliceSendsAfterOpen: {}
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
                        interactionExecutionNumber: 4
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'data channel closed after open',
                            code: 1000,
                            readyState: 'closed'
                        }
                    }
                },
                waitForDataChannelClose: {}
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
        dataChannel.readyState = 'open';
        dataChannel.onopen?.({
            type: 'open'
        });
    }, 25);

    const report = await reportPromise;

    assertEquals(report.summary.failure, 0);
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.aliceSendsAfterOpen[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS');
    assertEquals(report.resultsByName.waitForDataChannelClose[0].status, 'SUCCESS');
    assertEquals(sentWireMessages, [
        '{"topic":"chat.message","payload":{"text":"hello after open"}}'
    ]);
});
