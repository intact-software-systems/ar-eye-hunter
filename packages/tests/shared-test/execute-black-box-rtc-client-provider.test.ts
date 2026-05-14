import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
    executeBlackBox,
} from '../../shared-test/black-box-runner/execute-black-box.ts'
import {
    createRtcProviderFromClientFactory,
    type RtcClient,
} from '../../shared-test/black-box-runner/rtc-provider.ts'

import {
    createRallarRtcClientEventDispatcher,
    createRallarRtcClientFromOperations,
    createRallarRtcClientFromRuntime,
    createRallarRtcProvider,
    createRallarRtcProviderFromRuntime,
    createRallarRtcRuntimeFromDataChannelFactory,
    createRallarRtcProviderFromDataChannelFactory,
    decodeRallarRtcMessage,
    encodeRallarRtcMessage,
    toRallarRtcClientArgs,
    type RallarRtcClientArgs,
    type RallarRtcClientEventDispatcher,
    type RallarRtcMessageCodec,
} from '../../shared-test/black-box-runner/rallar-rtc-provider.ts'

import {
    createRallarWebRtcProvider,
    createRallarWebRtcRuntime,
    createRallarWebRtcSignalingOnlyProvider,
    createRallarWebRtcWebSocketSignalingFactory,
    createRallarWebRtcWebSocketSignalingProvider,
} from '../../shared-test/black-box-runner/rallar-webrtc-runtime.ts'

import {
    createRallarInMemoryProvider,
    createRallarInMemoryRuntime,
} from '../../shared-test/black-box-runner/rallar-in-memory-runtime.ts'

type FakeRtcClient = RtcClient & {
    connected: boolean
    closed: boolean
    sentMessages: unknown[]
    emitMessage: (message: unknown) => void
    emitClose: (event: unknown) => void
}

function createFakeRtcClient(): FakeRtcClient {
    let messageHandler: ((message: unknown) => void) | undefined
    let closeHandler: ((event: unknown) => void) | undefined

    return {
        connected: false,
        closed: false,
        sentMessages: [],

        async connect() {
            this.connected = true
        },

        async send(message: unknown) {
            this.sentMessages.push(message)
        },

        async close() {
            this.closed = true
            closeHandler?.({
                reason: 'closed by fake client',
            })
        },

        onMessage(handler: (message: unknown) => void) {
            messageHandler = handler
        },

        onClose(handler: (event: unknown) => void) {
            closeHandler = handler
        },

        emitMessage(message: unknown) {
            messageHandler?.(message)
        },

        emitClose(event: unknown) {
            closeHandler?.(event)
        },
    }
}

Deno.test('createRallarRtcClientEventDispatcher emits messages to registered handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher()
    const receivedMessages: unknown[] = []

    dispatcher.onMessage(message => {
        receivedMessages.push(message)
    })

    dispatcher.emitMessage({
        topic: 'chat.message',
        payload: {
            text: 'hello',
        },
    })

    assertEquals(receivedMessages, [
        {
            topic: 'chat.message',
            payload: {
                text: 'hello',
            },
        },
    ])
})

Deno.test('createRallarRtcClientEventDispatcher emits close events to registered handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher()
    const receivedCloseEvents: unknown[] = []

    dispatcher.onClose(event => {
        receivedCloseEvents.push(event)
    })

    dispatcher.emitClose({
        code: 1000,
        reason: 'normal close',
    })

    assertEquals(receivedCloseEvents, [
        {
            code: 1000,
            reason: 'normal close',
        },
    ])
})

Deno.test('createRallarRtcClientEventDispatcher supports multiple handlers', () => {
    const dispatcher = createRallarRtcClientEventDispatcher()
    const firstHandlerMessages: unknown[] = []
    const secondHandlerMessages: unknown[] = []

    dispatcher.onMessage(message => {
        firstHandlerMessages.push(message)
    })

    dispatcher.onMessage(message => {
        secondHandlerMessages.push(message)
    })

    dispatcher.emitMessage({
        topic: 'presence.update',
    })

    assertEquals(firstHandlerMessages, [
        {
            topic: 'presence.update',
        },
    ])

    assertEquals(secondHandlerMessages, [
        {
            topic: 'presence.update',
        },
    ])
})

Deno.test('createRallarRtcClientFromOperations delegates connect send and close operations', async () => {
    const calls: Array<{ operation: string; args: RallarRtcClientArgs; message?: unknown }> = []
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
        actor: 'alice',
        roomId: 'room-1',
    })

    const client = createRallarRtcClientFromOperations(args, {
        connect: operationArgs => {
            calls.push({
                operation: 'connect',
                args: operationArgs,
            })
        },
        send: (message, operationArgs) => {
            calls.push({
                operation: 'send',
                args: operationArgs,
                message,
            })
        },
        close: operationArgs => {
            calls.push({
                operation: 'close',
                args: operationArgs,
            })
        },
    })

    await client.connect()
    await client.send({
        topic: 'chat.message',
    })
    await client.close()

    assertEquals(calls.map(call => call.operation), ['connect', 'send', 'close'])
    assertEquals(calls[0].args.connection, 'aliceRtc')
    assertEquals(calls[1].message, {
        topic: 'chat.message',
    })
    assertEquals(calls[2].args.roomId, 'room-1')
})

Deno.test('createRallarRtcClientFromOperations exposes dispatcher to operations', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })
    const receivedMessages: unknown[] = []
    const receivedCloseEvents: unknown[] = []
    let connectDispatcher: RallarRtcClientEventDispatcher | undefined
    let closeDispatcher: RallarRtcClientEventDispatcher | undefined

    const client = createRallarRtcClientFromOperations(args, {
        connect: (_args, dispatcher) => {
            connectDispatcher = dispatcher
            dispatcher.emitMessage({
                topic: 'connected',
            })
        },
        send: (_message, _args, dispatcher) => {
            dispatcher.emitMessage({
                topic: 'echo',
            })
        },
        close: (_args, dispatcher) => {
            closeDispatcher = dispatcher
            dispatcher.emitClose({
                reason: 'closed by operation',
            })
        },
    })

    client.onMessage?.(message => {
        receivedMessages.push(message)
    })

    client.onClose?.(event => {
        receivedCloseEvents.push(event)
    })

    await client.connect()
    await client.send({
        topic: 'ping',
    })
    await client.close()

    assertEquals(connectDispatcher !== undefined, true)
    assertEquals(closeDispatcher !== undefined, true)
    assertEquals(receivedMessages, [
        {
            topic: 'connected',
        },
        {
            topic: 'echo',
        },
    ])
    assertEquals(receivedCloseEvents, [
        {
            reason: 'closed by operation',
        },
    ])
})

Deno.test('createRallarRtcClientFromOperations propagates operation failures', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromOperations(args, {
        connect: () => {
            throw new Error('connect failed')
        },
        send: () => {
            throw new Error('send failed')
        },
        close: () => {
            throw new Error('close failed')
        },
    })

    await client.connect()
        .then(() => {
            throw new Error('Expected connect to fail')
        })
        .catch(error => {
            assertEquals(error.message, 'connect failed')
        })

    await client.send({})
        .then(() => {
            throw new Error('Expected send to fail')
        })
        .catch(error => {
            assertEquals(error.message, 'send failed')
        })

    await client.close()
        .then(() => {
            throw new Error('Expected close to fail')
        })
        .catch(error => {
            assertEquals(error.message, 'close failed')
        })
})

Deno.test('createRallarRtcClientFromRuntime connects and delegates to runtime session', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
        actor: 'alice',
        roomId: 'room-1',
    })
    const sentMessages: unknown[] = []
    let runtimeConnectCalled = false
    let sessionClosed = false

    const client = createRallarRtcClientFromRuntime(args, {
        connect: (runtimeArgs, dispatcher) => {
            runtimeConnectCalled = true
            dispatcher.emitMessage({
                topic: 'runtime.connected',
                connection: runtimeArgs.connection,
            })

            return {
                send: message => {
                    sentMessages.push(message)
                },
                close: () => {
                    sessionClosed = true
                    dispatcher.emitClose({
                        reason: 'runtime session closed',
                    })
                },
            }
        },
    })

    const receivedMessages: unknown[] = []
    const receivedCloseEvents: unknown[] = []

    client.onMessage?.(message => {
        receivedMessages.push(message)
    })

    client.onClose?.(event => {
        receivedCloseEvents.push(event)
    })

    await client.connect()
    await client.send({
        topic: 'chat.message',
    })
    await client.close()

    assertEquals(runtimeConnectCalled, true)
    assertEquals(sentMessages, [
        {
            topic: 'chat.message',
        },
    ])
    assertEquals(sessionClosed, true)
    assertEquals(receivedMessages, [
        {
            topic: 'runtime.connected',
            connection: 'aliceRtc',
        },
    ])
    assertEquals(receivedCloseEvents, [
        {
            reason: 'runtime session closed',
        },
    ])
})

Deno.test('createRallarRtcClientFromRuntime rejects send before connect', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromRuntime(args, {
        connect: () => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    // no-op
                },
            }
        },
    })

    await client.send({
        topic: 'chat.message',
    })
        .then(() => {
            throw new Error('Expected send before connect to fail')
        })
        .catch(error => {
            assertEquals(
                error.message,
                'Rallar RTC client is not connected for connection: aliceRtc',
            )
        })
})

Deno.test('createRallarRtcClientFromRuntime close before connect is a no-op', async () => {
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })
    let runtimeConnectCalled = false

    const client = createRallarRtcClientFromRuntime(args, {
        connect: () => {
            runtimeConnectCalled = true
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    // no-op
                },
            }
        },
    })

    await client.close()

    assertEquals(runtimeConnectCalled, false)
})

Deno.test('encodeRallarRtcMessage serializes object messages', () => {
    assertEquals(
        encodeRallarRtcMessage({
            topic: 'chat.message',
            payload: {
                text: 'hello',
            },
        }),
        '{"topic":"chat.message","payload":{"text":"hello"}}',
    )
})

Deno.test('encodeRallarRtcMessage keeps string messages unchanged', () => {
    assertEquals(encodeRallarRtcMessage('plain text'), 'plain text')
})

Deno.test('encodeRallarRtcMessage fails clearly for undefined message', () => {
    try {
        encodeRallarRtcMessage(undefined)
        throw new Error('Expected undefined message encoding to fail')
    }
    catch (error) {
        assertEquals((error as Error).message, 'Rallar RTC message cannot be encoded as JSON')
    }
})

Deno.test('decodeRallarRtcMessage parses JSON strings', () => {
    assertEquals(
        decodeRallarRtcMessage('{"topic":"chat.message","payload":{"text":"hello"}}'),
        {
            topic: 'chat.message',
            payload: {
                text: 'hello',
            },
        },
    )
})

Deno.test('decodeRallarRtcMessage keeps non-json strings unchanged', () => {
    assertEquals(decodeRallarRtcMessage('plain text'), 'plain text')
})

Deno.test('decodeRallarRtcMessage keeps non-string values unchanged', () => {
    const message = {
        topic: 'already.object',
    }

    assertEquals(decodeRallarRtcMessage(message), message)
})

Deno.test('createRallarRtcRuntimeFromDataChannelFactory sends encoded messages and decodes received messages', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    const sentWireMessages: string[] = []
    let closeCalled = false

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            closeCalled = true
            listeners.close?.forEach(listener => listener({
                code: 1000,
                reason: 'normal close',
            }))
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({
        connect: () => dataChannel,
    })

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromRuntime(args, runtime)
    const receivedMessages: unknown[] = []
    const receivedCloseEvents: unknown[] = []

    client.onMessage?.(message => {
        receivedMessages.push(message)
    })

    client.onClose?.(event => {
        receivedCloseEvents.push(event)
    })

    await client.connect()
    await client.send({
        topic: 'chat.message',
        payload: {
            text: 'hello',
        },
    })

    listeners.message.forEach(listener => listener({
        data: '{"topic":"chat.message","payload":{"text":"from wire"}}',
    }))

    await client.close()

    assertEquals(sentWireMessages, [
        '{"topic":"chat.message","payload":{"text":"hello"}}',
    ])

    assertEquals(receivedMessages, [
        {
            topic: 'chat.message',
            payload: {
                text: 'from wire',
            },
        },
    ])

    assertEquals(closeCalled, true)
    assertEquals((receivedCloseEvents[0] as any).reason, 'normal close')
    assertEquals((receivedCloseEvents[0] as any).code, 1000)
    assertEquals((receivedCloseEvents[0] as any).phase, 'close')
})

Deno.test('createRallarRtcRuntimeFromDataChannelFactory supports onmessage and onclose fallback handlers', async () => {
    const sentWireMessages: string[] = []
    let closeCalled = false

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            closeCalled = true
            dataChannel.onclose?.({
                code: 1000,
                reason: 'closed through onclose fallback',
            })
        },
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null,
    }

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({
        connect: () => dataChannel,
    })

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromRuntime(args, runtime)
    const receivedMessages: unknown[] = []
    const receivedCloseEvents: unknown[] = []

    client.onMessage?.(message => {
        receivedMessages.push(message)
    })

    client.onClose?.(event => {
        receivedCloseEvents.push(event)
    })

    await client.connect()
    await client.send({
        topic: 'chat.message',
    })

    dataChannel.onmessage?.({
        data: '{"topic":"fallback.message"}',
    })

    await client.close()

    assertEquals(sentWireMessages, [
        '{"topic":"chat.message"}',
    ])

    assertEquals(receivedMessages, [
        {
            topic: 'fallback.message',
        },
    ])

    assertEquals(closeCalled, true)
    assertEquals((receivedCloseEvents[0] as any).reason, 'closed through onclose fallback')
    assertEquals((receivedCloseEvents[0] as any).code, 1000)
    assertEquals((receivedCloseEvents[0] as any).phase, 'close')
})

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
        onerror: null as ((event: any) => void) | null,
    }

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({
        connect: () => dataChannel,
    })

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromRuntime(args, runtime)
    const receivedCloseEvents: unknown[] = []

    client.onClose?.(event => {
        receivedCloseEvents.push(event)
    })

    await client.connect()

    dataChannel.onerror?.({
        message: 'data channel error',
    })

    assertEquals(receivedCloseEvents, [
        {
            event: {
                message: 'data channel error',
            },
            error: true,
            phase: 'error',
            message: 'data channel error',
            readyState: 'closing',
        },
    ])
})

Deno.test('createRallarRtcProviderFromDataChannelFactory supports scenario execution through data channel', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    const sentWireMessages: string[] = []

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data)
            listeners.message?.forEach(listener => listener({
                data,
            }))
        },
        close: () => {
            listeners.close?.forEach(listener => listener({
                code: 1000,
                reason: 'closed by provider data channel',
            }))
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        connect: () => dataChannel,
    })

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through data channel provider',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload,
                    },
                },
                aliceSendsAndReceivesEcho: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(sentWireMessages, [
        '{"topic":"chat.message","payload":{"text":"hello through data channel provider"}}',
    ])
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload)
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
})

Deno.test('createRallarRtcProviderFromDataChannelFactory supports custom wire message codec', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    const sentWireMessages: string[] = []

    const codec: RallarRtcMessageCodec = {
        encode: message => 'wire:' + JSON.stringify(message),
        decode: data => {
            const wireData = String(data)
            return JSON.parse(wireData.substring('wire:'.length))
        },
    }

    const dataChannel = {
        readyState: 'open',
        send: (data: string) => {
            sentWireMessages.push(data)
            listeners.message?.forEach(listener => listener({
                data,
            }))
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        codec,
        connect: () => dataChannel,
    })

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through custom codec',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload,
                    },
                },
                aliceSendsAndReceivesCustomCodecEcho: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(sentWireMessages, [
        'wire:{"topic":"chat.message","payload":{"text":"hello through custom codec"}}',
    ])
    assertEquals(report.resultsByName.aliceSendsAndReceivesCustomCodecEcho[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesCustomCodecEcho[0].actual.matchedMessage.data, payload)
})

Deno.test('createRallarRtcProviderFromDataChannelFactory records close event when custom decode fails', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const dataChannel = {
        readyState: 'open',
        send: (_data: string) => {
            listeners.message?.forEach(listener => listener({
                data: 'bad-wire-message',
            }))
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        codec: {
            decode: () => {
                throw new Error('custom decode failed')
            },
        },
        connect: () => dataChannel,
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsBadWireMessage: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceSendsBadWireMessage[0].status, 'SUCCESS')
    assertEquals(report.rtcCloseEvents.aliceRtc[0].error, true)
    assertEquals(report.rtcCloseEvents.aliceRtc[0].phase, 'decode')
    assertEquals(report.rtcCloseEvents.aliceRtc[0].message, 'custom decode failed')
    assertEquals(report.rtcCloseEvents.aliceRtc[0].readyState, 'open')
    assertEquals(report.rtcCloseEvents.aliceRtc[0].event.error, true)
})

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
                        reason: 'closed by flattened runtime provider',
                    })
                },
            }
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'closed by flattened runtime provider',
                        },
                    },
                },
                waitForFlattenedRuntimeClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.waitForFlattenedRuntimeClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForFlattenedRuntimeClose[0].actual.matchedCloseEvent.phase, 'close')
    assertEquals(
        report.resultsByName.waitForFlattenedRuntimeClose[0].actual.matchedCloseEvent.event.reason,
        'closed by flattened runtime provider',
    )
})

Deno.test('createRallarRtcProviderFromDataChannelFactory reports failure when data channel is not open', async () => {
    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            throw new Error('send should not be called while connecting')
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        connect: () => dataChannel,
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsTooEarly: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSendsTooEarly[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsTooEarly[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsTooEarly[0].actual.exception,
        'Rallar RTC data channel is not open. readyState=connecting',
    )
})

Deno.test('createRallarRtcProviderFromDataChannelFactory reports failure when message cannot be encoded', async () => {
    const dataChannel = {
        readyState: 'open',
        send: (_data: string) => {
            throw new Error('send should not be called when encoding fails')
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        connect: () => dataChannel,
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: undefined,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsUndefined: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSendsUndefined[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsUndefined[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsUndefined[0].actual.exception,
        'Rallar RTC message cannot be encoded as JSON',
    )
})

Deno.test('createRallarRtcRuntimeFromDataChannelFactory can wait for data channel open during connect', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({
        waitForOpen: true,
        openTimeoutMs: 1000,
        connect: () => dataChannel,
    })

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromRuntime(args, runtime)

    const connectPromise = client.connect()

    setTimeout(() => {
        dataChannel.readyState = 'open'
        listeners.open?.forEach(listener => listener({
            type: 'open',
        }))
    }, 25)

    await connectPromise

    assertEquals(dataChannel.readyState, 'open')
})

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
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        waitForOpen: true,
        openTimeoutMs: 50,
        connect: () => dataChannel,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar RTC data channel did not open within 50ms. readyState=connecting',
    )
})

Deno.test('createRallarRtcProviderFromDataChannelFactory reports connect failure when data channel closes before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        waitForOpen: true,
        openTimeoutMs: 1000,
        connect: () => dataChannel,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    setTimeout(() => {
        dataChannel.readyState = 'closed'
        listeners.close?.forEach(listener => listener({
            code: 1006,
            reason: 'closed while connecting',
        }))
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar RTC data channel closed before open. readyState=closed, code=1006, reason=closed while connecting',
    )
})

Deno.test('createRallarRtcProviderFromDataChannelFactory reports connect failure when data channel errors before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        waitForOpen: true,
        openTimeoutMs: 1000,
        connect: () => dataChannel,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    setTimeout(() => {
        dataChannel.readyState = 'closing'
        listeners.error?.forEach(listener => listener({
            message: 'ICE failed while connecting',
        }))
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar RTC data channel failed before open. readyState=closing, message=ICE failed while connecting',
    )
})

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
        onerror: null as ((event: any) => void) | null,
    }

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({
        waitForOpen: true,
        openTimeoutMs: 1000,
        connect: () => dataChannel,
    })

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    const client = createRallarRtcClientFromRuntime(args, runtime)
    const connectPromise = client.connect()

    setTimeout(() => {
        dataChannel.readyState = 'open'
        dataChannel.onopen?.({
            type: 'open',
        })
    }, 25)

    await connectPromise

    assertEquals(dataChannel.readyState, 'open')
})

Deno.test('createRallarRtcRuntimeFromDataChannelFactory can use request waitForOpen settings', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const dataChannel = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const runtime = createRallarRtcRuntimeFromDataChannelFactory({
        connect: () => dataChannel,
    })

    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
        waitForOpen: true,
        openTimeoutMs: 1000,
    })

    const client = createRallarRtcClientFromRuntime(args, runtime)
    const connectPromise = client.connect()

    setTimeout(() => {
        dataChannel.readyState = 'open'
        listeners.open?.forEach(listener => listener({
            type: 'open',
        }))
    }, 25)

    await connectPromise

    assertEquals(dataChannel.readyState, 'open')
})

Deno.test('createRallarRtcProviderFromDataChannelFactory preserves fallback close handler after waitForOpen', async () => {
    const sentWireMessages: string[] = []

    const dataChannel = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            dataChannel.readyState = 'closed'
            dataChannel.onclose?.({
                code: 1000,
                reason: 'data channel closed after open',
            })
        },
        onopen: null as ((event: any) => void) | null,
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null,
    }

    const provider = createRallarRtcProviderFromDataChannelFactory({
        connect: () => dataChannel,
        waitForOpen: true,
        openTimeoutMs: 1000,
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello after open',
                            },
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsAfterOpen: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
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
                        interactionExecutionNumber: 4,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'data channel closed after open',
                            code: 1000,
                            readyState: 'closed',
                        },
                    },
                },
                waitForDataChannelClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    setTimeout(() => {
        dataChannel.readyState = 'open'
        dataChannel.onopen?.({
            type: 'open',
        })
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAfterOpen[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForDataChannelClose[0].status, 'SUCCESS')
    assertEquals(sentWireMessages, [
        '{"topic":"chat.message","payload":{"text":"hello after open"}}',
    ])
})

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
                Authorization: 'Bearer token',
            },
            protocol: 'rallar-signaling',
        },
        channel: {
            label: 'game-data',
        },
        rtcConfig: {
            iceServers: [
                {
                    urls: 'stun:stun.example.test',
                },
            ],
        },
        timeoutMs: 3000,
        waitForOpen: true,
        openTimeoutMs: 2000,
        metadata: {
            testRunId: 'test-run-1',
        },
    }

    const args = toRallarRtcClientArgs(request)

    assertEquals(args.connection, 'aliceRtc')
    assertEquals(args.provider, 'rallar-stub')
    assertEquals(args.actor, 'alice')
    assertEquals(args.peerId, 'alice-peer')
    assertEquals(args.remotePeerId, 'bob-peer')
    assertEquals(args.roomId, 'room-1')
    assertEquals(args.groupId, 'room-1')
    assertEquals(args.overlayId, 'room-1')
    assertEquals(args.signalingUrl, 'ws://localhost:8080/ws')
    assertEquals(args.signalingType, 'ws')
    assertEquals(args.signalingHeaders, {
        Authorization: 'Bearer token',
    })
    assertEquals(args.signalingProtocols, 'rallar-signaling')
    assertEquals(args.dataChannelLabel, 'game-data')
    assertEquals(args.iceServers, [
        {
            urls: 'stun:stun.example.test',
        },
    ])
    assertEquals(args.timeoutMs, 3000)
    assertEquals(args.connectTimeoutMs, 3000)
    assertEquals(args.waitForOpen, true)
    assertEquals(args.openTimeoutMs, 2000)
    assertEquals(args.metadata, {
        testRunId: 'test-run-1',
    })
    assertEquals(args.request, request)
})

Deno.test('toRallarRtcClientArgs supports aliases and safe defaults', () => {
    const request = {
        connectionId: 'aliceRtc',
        clientId: 'alice-client',
        targetActor: 'bob',
        overlayId: 'overlay-1',
        signaling: {
            wsUrl: 'ws://localhost:8080/signaling',
            protocols: ['rallar-v1'],
        },
        connectTimeoutMs: 5000,
    }

    const args = toRallarRtcClientArgs(request)

    assertEquals(args.connection, 'aliceRtc')
    assertEquals(args.provider, 'rallar')
    assertEquals(args.peerId, 'alice-client')
    assertEquals(args.remotePeerId, 'bob')
    assertEquals(args.groupId, 'overlay-1')
    assertEquals(args.overlayId, 'overlay-1')
    assertEquals(args.signalingUrl, 'ws://localhost:8080/signaling')
    assertEquals(args.signalingProtocols, ['rallar-v1'])
    assertEquals(args.dataChannelLabel, 'rallar')
    assertEquals(args.connectTimeoutMs, 5000)
})

Deno.test('createRallarRtcProvider maps request to Rallar client factory args', async () => {
    const fakeClient = createFakeRtcClient()
    let capturedArgs: any
    let capturedConfig: any
    let capturedContext: any

    const provider = createRallarRtcProvider({
        createClient: (args, config, context) => {
            capturedArgs = args
            capturedConfig = config
            capturedContext = context
            return fakeClient
        },
    })

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
                            url: 'ws://localhost:8080/ws',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(fakeClient.connected, true)
    assertEquals(capturedArgs.connection, 'aliceRtc')
    assertEquals(capturedArgs.provider, 'rallar')
    assertEquals(capturedArgs.actor, 'alice')
    assertEquals(capturedArgs.peerId, 'alice')
    assertEquals(capturedArgs.roomId, 'room-1')
    assertEquals(capturedArgs.groupId, 'room-1')
    assertEquals(capturedArgs.signalingUrl, 'ws://localhost:8080/ws')
    assertEquals(capturedArgs.signalingType, 'ws')
    assertEquals(capturedConfig.interactionName, 'connectAlice')
    assertEquals(capturedContext.rtcProviders.rallar !== undefined, true)
})

Deno.test('createRallarRtcProvider supports operations-based Rallar client messages', async () => {
    const provider = createRallarRtcProvider({
        createClient: args => {
            return createRallarRtcClientFromOperations(args, {
                connect: () => {
                    // no-op for fake operations client
                },
                send: (message, _args, dispatcher) => {
                    dispatcher.emitMessage(message)
                },
                close: (_args, dispatcher) => {
                    dispatcher.emitClose({
                        reason: 'closed by operations client',
                    })
                },
            })
        },
    })

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello from operations client',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload,
                    },
                },
                aliceSendsAndReceivesEcho: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload)
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.rtcCloseEvents.aliceRtc.length >= 1, true)
})

Deno.test('createRallarWebRtcRuntime fails clearly when createSession is missing', async () => {
    const runtime = createRallarWebRtcRuntime()
    const args = toRallarRtcClientArgs({
        connection: 'aliceRtc',
        provider: 'rallar',
    })

    try {
        await runtime.connect(args, createRallarRtcClientEventDispatcher())
        throw new Error('Expected runtime connect to fail')
    }
    catch (error) {
        assertEquals(
            (error as Error).message,
            'Rallar WebRTC runtime is not implemented yet. Missing createSession implementation for connection: aliceRtc',
        )
    }
})

Deno.test('createRallarWebRtcProvider reports clear connect failure when createSession is missing', async () => {
    const provider = createRallarWebRtcProvider()

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC runtime is not implemented yet. Missing createSession implementation for connection: aliceRtc',
    )
})

Deno.test('createRallarWebRtcProvider can execute scenario through injected createSession', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: (_args, dispatcher) => {
            return {
                send: message => {
                    dispatcher.emitMessage(message)
                },
                close: () => {
                    dispatcher.emitClose({
                        phase: 'close',
                        reason: 'closed by injected WebRTC session',
                    })
                },
            }
        },
    })

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through injected WebRTC session',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload,
                    },
                },
                aliceSendsAndReceivesEcho: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload)
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
})

Deno.test('createRallarWebRtcSignalingOnlyProvider can connect and close signaling session', async () => {
    const signalingEvents: unknown[] = []

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: args => {
                signalingEvents.push({
                    type: 'connect',
                    connection: args.connection,
                    peerId: args.peerId,
                    roomId: args.roomId,
                    signalingUrl: args.signalingUrl,
                })

                return {
                    close: () => {
                        signalingEvents.push({
                            type: 'close',
                            connection: args.connection,
                        })
                    },
                }
            },
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: {
                            topic: 'rallar.webrtc.signaling.connected',
                            connection: 'aliceRtc',
                            peerId: 'alice',
                            roomId: 'room-1',
                            signalingUrl: 'ws://localhost:8080/ws',
                        },
                    },
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
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
                        interactionExecutionNumber: 3,
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
                        },
                    },
                },
                waitForAliceClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS')
    assertEquals(report.rtcMessages.aliceRtc[0].data.actor, 'alice')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy, 'rallar-webrtc-signaling-only-runtime')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.actor, 'alice')
    assertEquals(signalingEvents, [
        {
            type: 'connect',
            connection: 'aliceRtc',
            peerId: 'alice',
            roomId: 'room-1',
            signalingUrl: 'ws://localhost:8080/ws',
        },
        {
            type: 'close',
            connection: 'aliceRtc',
        },
    ])
})

Deno.test('createRallarWebRtcSignalingOnlyProvider emits group and overlay diagnostics', async () => {
    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    close: () => {
                        // no-op
                    },
                }
            },
        },
    })

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
                        interactionExecutionNumber: 1,
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
                            overlayId: 'overlay-1',
                        },
                    },
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
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
                        interactionExecutionNumber: 3,
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
                            overlayId: 'overlay-1',
                        },
                    },
                },
                waitForAliceClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS')
    assertEquals(report.rtcMessages.aliceRtc[0].data.groupId, 'group-1')
    assertEquals(report.rtcMessages.aliceRtc[0].data.overlayId, 'overlay-1')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId, 'group-1')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId, 'overlay-1')
})

Deno.test('createRallarWebRtcSignalingOnlyProvider reports send failure when data channel is missing', async () => {
    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    close: () => {
                        // no-op
                    },
                }
            },
        },
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsWithoutDataChannel: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsWithoutDataChannel[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsWithoutDataChannel[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsWithoutDataChannel[0].actual.exception,
        'Rallar WebRTC data channel is not implemented yet. Signaling-only runtime cannot send RTC payload for connection: aliceRtc',
    )
})

Deno.test('createRallarWebRtcSignalingOnlyProvider delegates send to signaling session when available', async () => {
    const signalingEvents: unknown[] = []

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: args => {
                signalingEvents.push({
                    type: 'connect',
                    connection: args.connection,
                    peerId: args.peerId,
                    roomId: args.roomId,
                })

                return {
                    send: message => {
                        signalingEvents.push({
                            type: 'send',
                            connection: args.connection,
                            message,
                        })
                    },
                    close: () => {
                        signalingEvents.push({
                            type: 'close',
                            connection: args.connection,
                        })
                    },
                }
            },
        },
    })

    const signalingMessage = {
        topic: 'rallar.webrtc.signaling.offer',
        payload: {
            from: 'alice',
            to: 'bob',
            sdp: 'fake-offer-sdp',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: signalingMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsSignalingOffer: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsSignalingOffer[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(signalingEvents, [
        {
            type: 'connect',
            connection: 'aliceRtc',
            peerId: 'alice',
            roomId: 'room-1',
        },
        {
            type: 'send',
            connection: 'aliceRtc',
            message: signalingMessage,
        },
        {
            type: 'close',
            connection: 'aliceRtc',
        },
    ])
})

Deno.test('createRallarWebRtcSignalingOnlyProvider forwards incoming signaling messages', async () => {
    const signalingMessageHandlers: Array<(message: any) => void> = []

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    send: () => {
                        signalingMessageHandlers.forEach(handler => handler({
                            type: 'answer',
                            from: 'bob',
                            to: 'alice',
                            sdp: 'fake-answer-sdp',
                        }))
                    },
                    close: () => {
                        // no-op
                    },
                    onMessage: handler => {
                        signalingMessageHandlers.push(handler)
                    },
                }
            },
        },
    })

    const offer = {
        topic: 'rallar.webrtc.signaling.offer',
        payload: {
            from: 'alice',
            to: 'bob',
            sdp: 'fake-offer-sdp',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: offer,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
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
                                sdp: 'fake-answer-sdp',
                            },
                        },
                    },
                },
                aliceReceivesSignalingAnswer: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].status, 'SUCCESS')
    assertEquals(report.rtcMessages.aliceRtc[0].data.actor, 'alice')
})

Deno.test('createRallarWebRtcSignalingOnlyProvider forwards group and overlay on incoming signaling messages', async () => {
    const signalingMessageHandlers: Array<(message: any) => void> = []

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    send: () => {
                        signalingMessageHandlers.forEach(handler => handler({
                            type: 'answer',
                            from: 'bob',
                            to: 'alice',
                        }))
                    },
                    close: () => {
                        // no-op
                    },
                    onMessage: handler => {
                        signalingMessageHandlers.push(handler)
                    },
                }
            },
        },
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        send: {
                            type: 'offer',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
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
                                to: 'alice',
                            },
                        },
                    },
                },
                aliceReceivesSignalingAnswer: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].actual.matchedMessage.data.groupId, 'group-1')
    assertEquals(report.resultsByName.aliceReceivesSignalingAnswer[0].actual.matchedMessage.data.overlayId, 'overlay-1')
})

Deno.test('createRallarWebRtcSignalingOnlyProvider forwards signaling close events', async () => {
    const signalingCloseHandlers: Array<(event: any) => void> = []

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: {
            connect: () => {
                return {
                    send: () => {
                        signalingCloseHandlers.forEach(handler => handler({
                            code: 1006,
                            reason: 'signaling transport closed',
                        }))
                    },
                    close: () => {
                        // no-op
                    },
                    onClose: handler => {
                        signalingCloseHandlers.push(handler)
                    },
                }
            },
        },
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'rallar.webrtc.signaling.ping',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                triggerSignalingClose: {},
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
                        interactionExecutionNumber: 3,
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
                                reason: 'signaling transport closed',
                            },
                        },
                    },
                },
                waitForSignalingClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.triggerSignalingClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.closedBy, 'rallar-webrtc-signaling-only-runtime')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.actor, 'alice')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.transportEvent.code, 1006)
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.transportEvent.reason, 'signaling transport closed')
    assertEquals(report.resultsByName.waitForSignalingClose[0].actual.matchedCloseEvent.event.transportEvent.code, 1006)
    assertEquals(report.rtcMessages.aliceRtc[0].data.actor, 'alice')
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory bridges transport send message and close events', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    const sentWireMessages: string[] = []
    let transportCloseCalled = false

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data)
            listeners.message?.forEach(listener => listener({
                data: '{"type":"answer","from":"bob","to":"alice","sdp":"fake-answer-sdp"}',
            }))
        },
        close: () => {
            transportCloseCalled = true
            listeners.close?.forEach(listener => listener({
                code: 1000,
                reason: 'signaling closed normally',
            }))
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
        }),
    })

    const offer = {
        type: 'offer',
        from: 'alice',
        to: 'bob',
        sdp: 'fake-offer-sdp',
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: offer,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
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
                                sdp: 'fake-answer-sdp',
                            },
                        },
                    },
                },
                aliceReceivesAnswerFromTransport: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(sentWireMessages, [
        '{"type":"offer","from":"alice","to":"bob","sdp":"fake-offer-sdp"}',
    ])
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceReceivesAnswerFromTransport[0].status, 'SUCCESS')
    assertEquals(
        report.resultsByName.aliceReceivesAnswerFromTransport[0].actual.matchedMessage.data.actor,
        'alice',
    )
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(transportCloseCalled, true)
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory sends optional connect message after transport creation', async () => {
    const sentWireMessages: string[] = []

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    connection: args.connection,
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"connection":"aliceRtc","peerId":"alice","roomId":"room-1"}}',
    ])
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory can wait for transport open before connect message', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    const sentWireMessages: string[] = []

    const transport = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(sentWireMessages, [])

    setTimeout(() => {
        transport.readyState = 'open'
        listeners.open?.forEach(listener => listener({
            type: 'open',
        }))
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}',
    ])
    assertEquals(report.rtcMessages.aliceRtc[0].data.topic, 'rallar.webrtc.signaling.connected')
    assertEquals(report.rtcMessages.aliceRtc[0].data.opened, true)
    assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'open')
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory can use request waitForOpen settings', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}
    const sentWireMessages: string[] = []

    const transport = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(sentWireMessages, [])

    setTimeout(() => {
        transport.readyState = 'open'
        listeners.open?.forEach(listener => listener({
            type: 'open',
        }))
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}',
    ])
    assertEquals(report.rtcMessages.aliceRtc[0].data.topic, 'rallar.webrtc.signaling.connected')
    assertEquals(report.rtcMessages.aliceRtc[0].data.opened, true)
    assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'open')
})

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
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport did not open within 50ms. readyState=connecting',
    )
})

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
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport did not open within 60ms. readyState=connecting',
    )
})

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
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 40,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport did not open within 40ms. readyState=connecting',
    )
})

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
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 50,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport did not open within 50ms. readyState=connecting',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports connect failure when transport closes before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    setTimeout(() => {
        transport.readyState = 'closed'
        listeners.close?.forEach(listener => listener({
            code: 1006,
            reason: 'closed before open',
        }))
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport closed before open. readyState=closed, code=1006, reason=closed before open',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports connect failure when transport errors before open', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const transport = {
        readyState: 'connecting',
        send: (_data: string) => {
            // no-op
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    setTimeout(() => {
        transport.readyState = 'connecting'
        listeners.error?.forEach(listener => listener({
            message: 'error before open',
        }))
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAlice[0].actual.exception,
        'Rallar WebRTC signaling transport failed before open. readyState=connecting, message=error before open',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory skips connect message when hook returns undefined', async () => {
    const sentWireMessages: string[] = []

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            onConnectMessage: () => undefined,
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(sentWireMessages, [])
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory supports onmessage and onclose fallback handlers', async () => {
    const sentWireMessages: string[] = []
    let transportCloseCalled = false

    const transport = {
        send: (data: string) => {
            sentWireMessages.push(data)
            transport.onmessage?.({
                data: '{"type":"answer","from":"bob","to":"alice"}',
            })
        },
        close: () => {
            transportCloseCalled = true
            transport.onclose?.({
                code: 1000,
                reason: 'closed through onclose fallback',
            })
        },
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null,
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
        }),
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            type: 'offer',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
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
                            },
                        },
                    },
                },
                aliceReceivesFallbackAnswer: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(sentWireMessages, [
        '{"type":"offer"}',
    ])
    assertEquals(report.resultsByName.aliceReceivesFallbackAnswer[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(transportCloseCalled, true)
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory emits close event when decode fails', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const transport = {
        send: (_data: string) => {
            listeners.message?.forEach(listener => listener({
                data: 'bad-wire-message',
            }))
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            decode: () => {
                throw new Error('signaling decode failed')
            },
        }),
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            type: 'offer',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                triggerMalformedSignalingMessage: {},
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
                        interactionExecutionNumber: 3,
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
                                message: 'signaling decode failed',
                            },
                        },
                    },
                },
                waitForSignalingDecodeFailure: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.triggerMalformedSignalingMessage[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingDecodeFailure[0].status, 'SUCCESS')
    assertEquals(
        report.resultsByName.waitForSignalingDecodeFailure[0].actual.matchedCloseEvent.transportEvent.message,
        'signaling decode failed',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports send failure when encode fails', async () => {
    const transport = {
        send: (_data: string) => {
            throw new Error('transport send should not be called')
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            encode: () => {
                throw new Error('signaling encode failed')
            },
        }),
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            type: 'offer',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsUnencodableSignalingMessage: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsUnencodableSignalingMessage[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsUnencodableSignalingMessage[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsUnencodableSignalingMessage[0].actual.exception,
        'signaling encode failed',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory reports send failure when transport send fails', async () => {
    const transport = {
        send: (_data: string) => {
            throw new Error('signaling transport send failed')
        },
        close: () => {
            // no-op
        },
        addEventListener: (_type: string, _listener: (event: any) => void) => {
            // no-op
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
        }),
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            type: 'offer',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsThroughFailingTransport: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsThroughFailingTransport[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsThroughFailingTransport[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsThroughFailingTransport[0].actual.exception,
        'signaling transport send failed',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory emits close event when transport errors', async () => {
    const listeners: Record<string, Array<(event: any) => void>> = {}

    const transport = {
        send: (_data: string) => {
            listeners.error?.forEach(listener => listener({
                message: 'signaling transport error',
            }))
        },
        close: () => {
            // no-op
        },
        addEventListener: (type: string, listener: (event: any) => void) => {
            listeners[type] = listeners[type] || []
            listeners[type].push(listener)
        },
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
        }),
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            type: 'offer',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                triggerSignalingTransportError: {},
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
                        interactionExecutionNumber: 3,
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
                                message: 'signaling transport error',
                            },
                        },
                    },
                },
                waitForSignalingTransportError: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.triggerSignalingTransportError[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingTransportError[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingTransportError[0].actual.matchedCloseEvent.transportEvent.error, true)
    assertEquals(
        report.resultsByName.waitForSignalingTransportError[0].actual.matchedCloseEvent.transportEvent.message,
        'signaling transport error',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingProvider reports clear failure when signalingUrl is missing', async () => {
    const provider = createRallarWebRtcWebSocketSignalingProvider()

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAliceWithoutSignalingUrl: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAliceWithoutSignalingUrl[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAliceWithoutSignalingUrl[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAliceWithoutSignalingUrl[0].actual.exception,
        'Rallar WebRTC signalingUrl is required for connection: aliceRtc',
    )
})

Deno.test('createRallarWebRtcWebSocketSignalingProvider can use global WebSocket for signaling-only connect close', async () => {
    const originalWebSocket = globalThis.WebSocket
    const createdUrls: string[] = []
    const sentWireMessages: string[] = []
    const closeEvents: any[] = []

    class FakeWebSocket {
        onmessage: ((event: any) => void) | null = null
        onclose: ((event: any) => void) | null = null
        onerror: ((event: any) => void) | null = null

        constructor(url: string) {
            createdUrls.push(url)
        }

        send(data: string): void {
            sentWireMessages.push(data)
            this.onmessage?.({
                data: '{"type":"answer","from":"bob","to":"alice"}',
            })
        }

        close(): void {
            const event = {
                code: 1000,
                reason: 'fake websocket closed',
            }
            closeEvents.push(event)
            this.onclose?.(event)
        }
    }

    globalThis.WebSocket = FakeWebSocket as any

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider()

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
                            provider: 'rallar',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            send: {
                                type: 'offer',
                                from: 'alice',
                                to: 'bob',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
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
                                },
                            },
                        },
                    },
                    aliceReceivesFakeWebSocketAnswer: {},
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
                            interactionExecutionNumber: 3,
                        },
                        response: {},
                    },
                    closeAlice: {},
                },
            ],
            0,
            {
                rtcProviders: {
                    rallar: provider,
                },
            },
        )

        assertEquals(report.summary.failure, 0)
        assertEquals(createdUrls, ['ws://localhost:8080/ws'])
        assertEquals(sentWireMessages, [
            '{"type":"offer","from":"alice","to":"bob"}',
        ])
        assertEquals(closeEvents, [
            {
                code: 1000,
                reason: 'fake websocket closed',
            },
        ])
        assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
        assertEquals(report.resultsByName.aliceReceivesFakeWebSocketAnswer[0].status, 'SUCCESS')
        assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    }
    finally {
        globalThis.WebSocket = originalWebSocket
    }
})

Deno.test('createRallarWebRtcWebSocketSignalingProvider supports codec and connect message hooks', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentWireMessages: string[] = []

    class FakeWebSocket {
        onmessage: ((event: any) => void) | null = null
        onclose: ((event: any) => void) | null = null
        onerror: ((event: any) => void) | null = null

        constructor(_url: string) {
            // no-op
        }

        send(data: string): void {
            sentWireMessages.push(data)
            this.onmessage?.({
                data: 'wire:answer:bob:alice',
            })
        }

        close(): void {
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed',
            })
        }
    }

    globalThis.WebSocket = FakeWebSocket as any

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            encode: message => {
                if (message.topic === 'rallar.existing.signaling.join') {
                    return 'wire:join:' + message.payload.peerId + ':' + message.payload.roomId
                }

                return 'wire:' + message.type + ':' + message.from + ':' + message.to
            },
            decode: data => {
                const [_wire, type, from, to] = String(data).split(':')
                return {
                    type,
                    from,
                    to,
                }
            },
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        })

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
                            provider: 'rallar',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            send: {
                                type: 'offer',
                                from: 'alice',
                                to: 'bob',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
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
                                },
                            },
                        },
                    },
                    aliceReceivesHookDecodedAnswer: {},
                },
            ],
            0,
            {
                rtcProviders: {
                    rallar: provider,
                },
            },
        )

        assertEquals(report.summary.failure, 0)
        assertEquals(sentWireMessages, [
            'wire:join:alice:room-1',
            'wire:offer:alice:bob',
        ])
        assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
        assertEquals(report.resultsByName.aliceReceivesHookDecodedAnswer[0].status, 'SUCCESS')
    }
    finally {
        globalThis.WebSocket = originalWebSocket
    }
})

Deno.test('createRallarWebRtcWebSocketSignalingProvider can wait for fake WebSocket open', async () => {
    const originalWebSocket = globalThis.WebSocket
    const createdSockets: FakeWebSocket[] = []
    const sentWireMessages: string[] = []

    class FakeWebSocket {
        readyState: string | number = 'connecting'
        onopen: ((event: any) => void) | null = null
        onmessage: ((event: any) => void) | null = null
        onclose: ((event: any) => void) | null = null
        onerror: ((event: any) => void) | null = null

        constructor(_url: string) {
            createdSockets.push(this)
        }

        send(data: string): void {
            sentWireMessages.push(data)
        }

        close(): void {
            this.readyState = 'closed'
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed',
            })
        }
    }

    globalThis.WebSocket = FakeWebSocket as any

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            waitForOpen: true,
            openTimeoutMs: 1000,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        })

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
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
            ],
            0,
            {
                rtcProviders: {
                    rallar: provider,
                },
            },
        )

        assertEquals(sentWireMessages, [])

        setTimeout(() => {
            const socket = createdSockets[0]
            socket.readyState = 'open'
            socket.onopen?.({
                type: 'open',
            })
        }, 25)

        const report = await reportPromise

        assertEquals(report.summary.failure, 0)
        assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
        assertEquals(sentWireMessages, [
            '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}',
        ])
        assertEquals(report.rtcMessages.aliceRtc[0].data.topic, 'rallar.webrtc.signaling.connected')
        assertEquals(report.rtcMessages.aliceRtc[0].data.opened, true)
        assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'open')
    }
    finally {
        globalThis.WebSocket = originalWebSocket
    }
})

Deno.test('createRallarWebRtcWebSocketSignalingProvider waits for fake WebSocket open by default', async () => {
    const originalWebSocket = globalThis.WebSocket
    const createdSockets: FakeWebSocket[] = []
    const sentWireMessages: string[] = []

    class FakeWebSocket {
        readyState: string | number = 'connecting'
        onopen: ((event: any) => void) | null = null
        onmessage: ((event: any) => void) | null = null
        onclose: ((event: any) => void) | null = null
        onerror: ((event: any) => void) | null = null

        constructor(_url: string) {
            createdSockets.push(this)
        }

        send(data: string): void {
            sentWireMessages.push(data)
        }

        close(): void {
            this.readyState = 'closed'
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed',
            })
        }
    }

    globalThis.WebSocket = FakeWebSocket as any

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            openTimeoutMs: 1000,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        })

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
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
            ],
            0,
            {
                rtcProviders: {
                    rallar: provider,
                },
            },
        )

        assertEquals(sentWireMessages, [])

        setTimeout(() => {
            const socket = createdSockets[0]
            socket.readyState = 'open'
            socket.onopen?.({
                type: 'open',
            })
        }, 25)

        const report = await reportPromise

        assertEquals(report.summary.failure, 0)
        assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
        assertEquals(sentWireMessages, [
            '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}',
        ])
        assertEquals(report.rtcMessages.aliceRtc[0].data.opened, true)
        assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'open')
    }
    finally {
        globalThis.WebSocket = originalWebSocket
    }
})

Deno.test('createRallarWebRtcWebSocketSignalingProvider can disable default waitForOpen', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentWireMessages: string[] = []

    class FakeWebSocket {
        readyState: string | number = 'connecting'
        onopen: ((event: any) => void) | null = null
        onmessage: ((event: any) => void) | null = null
        onclose: ((event: any) => void) | null = null
        onerror: ((event: any) => void) | null = null

        constructor(_url: string) {
            // no-op
        }

        send(data: string): void {
            sentWireMessages.push(data)
        }

        close(): void {
            this.readyState = 'closed'
            this.onclose?.({
                code: 1000,
                reason: 'fake websocket closed',
            })
        }
    }

    globalThis.WebSocket = FakeWebSocket as any

    try {
        const provider = createRallarWebRtcWebSocketSignalingProvider({
            waitForOpen: false,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        })

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
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
            ],
            0,
            {
                rtcProviders: {
                    rallar: provider,
                },
            },
        )

        assertEquals(report.summary.failure, 0)
        assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
        assertEquals(sentWireMessages, [
            '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}',
        ])
        assertEquals(report.rtcMessages.aliceRtc[0].data.opened, false)
        assertEquals(report.rtcMessages.aliceRtc[0].data.readyState, 'connecting')
    }
    finally {
        globalThis.WebSocket = originalWebSocket
    }
})

Deno.test('createRallarWebRtcWebSocketSignalingFactory preserves fallback close handler after waitForOpen', async () => {
    const sentWireMessages: string[] = []

    const transport = {
        readyState: 'connecting',
        send: (data: string) => {
            sentWireMessages.push(data)
        },
        close: () => {
            transport.readyState = 'closed'
            transport.onclose?.({
                code: 1000,
                reason: 'closed after open',
            })
        },
        onopen: null as ((event: any) => void) | null,
        onmessage: null as ((event: any) => void) | null,
        onclose: null as ((event: any) => void) | null,
        onerror: null as ((event: any) => void) | null,
    }

    const provider = createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            createTransport: () => transport,
            waitForOpen: true,
            openTimeoutMs: 1000,
            onConnectMessage: args => ({
                topic: 'rallar.existing.signaling.join',
                payload: {
                    peerId: args.peerId,
                    roomId: args.roomId,
                },
            }),
        }),
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
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
                        interactionExecutionNumber: 3,
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
                                reason: 'closed after open',
                            },
                        },
                    },
                },
                waitForSignalingClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    setTimeout(() => {
        transport.readyState = 'open'
        transport.onopen?.({
            type: 'open',
        })
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForSignalingClose[0].status, 'SUCCESS')
    assertEquals(sentWireMessages, [
        '{"topic":"rallar.existing.signaling.join","payload":{"peerId":"alice","roomId":"room-1"}}',
    ])
})

Deno.test('createRallarWebRtcProvider can execute two-peer scenario through in-memory runtime', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

    const aliceToBob = {
        topic: 'chat.message',
        payload: {
            from: 'alice',
            to: 'bob',
            text: 'hello bob',
        },
    }

    const bobToAlice = {
        topic: 'chat.message',
        payload: {
            from: 'bob',
            to: 'alice',
            text: 'hello alice',
        },
    }

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
                        remotePeerId: 'bob',
                        roomId: 'room-1',
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: aliceToBob,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: aliceToBob,
                    },
                },
                aliceSendsToBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        send: bobToAlice,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: bobToAlice,
                    },
                },
                bobSendsToAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.bobSendsToAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob')
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveredTo, 'alice')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryMode, 'direct')
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliveryMode, 'direct')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence, 1)
    assertEquals(report.resultsByName.bobSendsToAlice[0].actual.matchedMessage.data.deliverySequence, 2)
})

Deno.test('createRallarWebRtcProvider routes in-memory message payload target before remotePeerId', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

    const messageToCharlie = {
        topic: 'chat.message',
        payload: {
            from: 'alice',
            to: 'charlie',
            text: 'hello charlie',
        },
    }

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
                        remotePeerId: 'bob',
                        roomId: 'room-1',
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                connectCharlie: {},
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: messageToCharlie,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4,
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 1000,
                        message: messageToCharlie,
                    },
                },
                aliceSendsPayloadTargetToCharlie: {},
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5,
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 100,
                        message: messageToCharlie,
                    },
                },
                bobDoesNotReceiveCharlieTargetedMessage: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.sentBy, 'alice')
    assertEquals(report.resultsByName.aliceSendsPayloadTargetToCharlie[0].actual.matchedMessage.data.deliveredTo, 'charlie')
    assertEquals(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].status, 'FAILURE')
    assertEquals(report.resultsByName.bobDoesNotReceiveCharlieTargetedMessage[0].result, 'Expected RTC message was not received')
})

Deno.test('createRallarInMemoryProvider can execute two-peer scenario', async () => {
    const provider = createRallarInMemoryProvider()

    const aliceToBob = {
        topic: 'chat.message',
        payload: {
            from: 'alice',
            to: 'bob',
            text: 'hello bob through provider factory',
        },
    }

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
                        remotePeerId: 'bob',
                        roomId: 'room-1',
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar-memory',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: aliceToBob,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: aliceToBob,
                    },
                },
                aliceSendsToBob: {},
            },
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliveryMode, 'direct')
    assertEquals(report.resultsByName.aliceSendsToBob[0].actual.matchedMessage.data.deliverySequence, 1)
})

Deno.test('createRallarInMemoryProvider reports failure when peer connects twice', async () => {
    const provider = createRallarInMemoryProvider()

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcOne',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAliceFirst: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcTwo',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectAliceSecond: {},
            },
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAliceFirst[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAliceSecond[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAliceSecond[0].result, 'RTC connect failed')
    assertEquals(
        report.resultsByName.connectAliceSecond[0].actual.exception,
        'Rallar in-memory RTC peer is already connected: alice',
    )
})

Deno.test('createRallarInMemoryProvider allows peer to reconnect after close', async () => {
    const provider = createRallarInMemoryProvider()

    const report = await executeBlackBox(
        [
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcOne',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAliceFirst: {},
            },
            {
                RTC: {
                    request: {
                        action: 'close',
                        connection: 'aliceRtcOne',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAliceFirst: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'aliceRtcTwo',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                connectAliceSecond: {},
            },
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAliceFirst[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAliceFirst[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAliceSecond[0].status, 'SUCCESS')
})

Deno.test('createRallarInMemoryProvider emits close diagnostics', async () => {
    const provider = createRallarInMemoryProvider()

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
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'closed by rallar in-memory runtime',
                            closedBy: 'rallar-in-memory-runtime',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                        },
                    },
                },
                waitForAliceClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.closedBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.connection, 'aliceRtc')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.roomId, 'room-1')
})

Deno.test('createRallarInMemoryProvider emits group and overlay close diagnostics', async () => {
    const provider = createRallarInMemoryProvider()

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
                        action: 'close',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'aliceRtc',
                        provider: 'rallar-memory',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        groupId: 'group-1',
                        overlayId: 'overlay-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            phase: 'close',
                            reason: 'closed by rallar in-memory runtime',
                            closedBy: 'rallar-in-memory-runtime',
                            connection: 'aliceRtc',
                            actor: 'alice',
                            peerId: 'alice',
                            roomId: 'room-1',
                            groupId: 'group-1',
                            overlayId: 'overlay-1',
                        },
                    },
                },
                waitForAliceClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.groupId, 'group-1')
    assertEquals(report.resultsByName.waitForAliceClose[0].actual.matchedCloseEvent.overlayId, 'overlay-1')
})

Deno.test('createRallarWebRtcProvider can broadcast through in-memory runtime when no target is specified', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

    const broadcastMessage = {
        topic: 'presence.update',
        payload: {
            from: 'alice',
            online: true,
        },
    }

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-2',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                connectCharlieDifferentRoom: {},
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
                        send: broadcastMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4,
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: broadcastMessage,
                    },
                },
                aliceBroadcastsToRoom: {},
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-2',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5,
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 100,
                        message: broadcastMessage,
                    },
                },
                charlieDoesNotReceiveOtherRoomBroadcast: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceBroadcastsToRoom[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceBroadcastsToRoom[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].status, 'FAILURE')
    assertEquals(report.resultsByName.charlieDoesNotReceiveOtherRoomBroadcast[0].result, 'Expected RTC message was not received')
})

Deno.test('createRallarWebRtcProvider can broadcast through in-memory runtime with explicit broadcast flag', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

    const broadcastMessage = {
        topic: 'presence.update',
        broadcast: true,
        payload: {
            from: 'alice',
            online: true,
        },
    }

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
                        remotePeerId: 'bob',
                        roomId: 'room-1',
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                connectCharlie: {},
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: broadcastMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4,
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: broadcastMessage,
                    },
                },
                aliceBroadcastsToBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5,
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 1000,
                        message: broadcastMessage,
                    },
                },
                charlieReceivesExplicitBroadcast: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob')
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveredTo, 'charlie')
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveryMode, 'broadcast')
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveryMode, 'broadcast')
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
    assertEquals(report.resultsByName.aliceBroadcastsToBob[0].actual.matchedMessage.data.deliverySequence, 1)
    assertEquals(report.resultsByName.charlieReceivesExplicitBroadcast[0].actual.matchedMessage.data.deliverySequence, 2)
})

Deno.test('createRallarWebRtcProvider can broadcast through in-memory runtime with payload broadcast flag', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

    const broadcastMessage = {
        topic: 'presence.update',
        payload: {
            broadcast: true,
            from: 'alice',
            online: true,
        },
    }

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
                        remotePeerId: 'bob',
                        roomId: 'room-1',
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
                        action: 'connect',
                        connection: 'bobRtc',
                        provider: 'rallar',
                        actor: 'bob',
                        peerId: 'bob',
                        remotePeerId: 'alice',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                connectBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'connect',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                connectCharlie: {},
            },
            {
                RTC: {
                    request: {
                        action: 'send',
                        connection: 'aliceRtc',
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'bob',
                        roomId: 'room-1',
                        send: broadcastMessage,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 4,
                    },
                    response: {
                        connection: 'bobRtc',
                        withinMs: 1000,
                        message: broadcastMessage,
                    },
                },
                alicePayloadBroadcastsToBob: {},
            },
            {
                RTC: {
                    request: {
                        action: 'wait',
                        connection: 'charlieRtc',
                        provider: 'rallar',
                        actor: 'charlie',
                        peerId: 'charlie',
                        roomId: 'room-1',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 5,
                    },
                    response: {
                        connection: 'charlieRtc',
                        withinMs: 1000,
                        message: broadcastMessage,
                    },
                },
                charlieReceivesPayloadBroadcast: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredBy, 'rallar-in-memory-runtime')
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveredTo, 'bob')
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveredTo, 'charlie')
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveryMode, 'broadcast')
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveryMode, 'broadcast')
    assertEquals(report.resultsByName.alicePayloadBroadcastsToBob[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
    assertEquals(report.resultsByName.charlieReceivesPayloadBroadcast[0].actual.matchedMessage.data.deliveryGroup, 'room-1')
})

Deno.test('createRallarWebRtcProvider reports in-memory runtime failure when broadcast has no targets', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'presence.update',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceBroadcastsToEmptyRoom: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceBroadcastsToEmptyRoom[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceBroadcastsToEmptyRoom[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceBroadcastsToEmptyRoom[0].actual.exception,
        'Rallar in-memory RTC broadcast has no connected targets for peer: alice',
    )
})

Deno.test('createRallarWebRtcProvider reports in-memory runtime failure when target is missing', async () => {
    const provider = createRallarWebRtcProvider({
        createSession: createRallarInMemoryRuntime().connect,
    })

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
                        remotePeerId: 'missing-bob',
                        roomId: 'room-1',
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
                        provider: 'rallar',
                        actor: 'alice',
                        peerId: 'alice',
                        remotePeerId: 'missing-bob',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSendsToMissingBob: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSendsToMissingBob[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSendsToMissingBob[0].result, 'RTC send failed')
    assertEquals(
        report.resultsByName.aliceSendsToMissingBob[0].actual.exception,
        'Rallar in-memory RTC target is not connected: missing-bob',
    )
})

Deno.test('RTC success status includes generic routing diagnostics', async () => {
    const provider = createRallarInMemoryProvider()

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                'rallar-memory': provider,
            },
        },
    )

    const result = report.resultsByName.connectAlice[0]

    assertEquals(report.summary.failure, 0)
    assertEquals(result.status, 'SUCCESS')
    assertEquals(result.peerId, 'alice')
    assertEquals(result.groupId, 'group-1')
    assertEquals(result.overlayId, 'overlay-1')
    assertEquals(result.remotePeerId, 'bob')
    assertEquals(result.actual.peerId, 'alice')
    assertEquals(result.actual.groupId, 'group-1')
    assertEquals(result.actual.overlayId, 'overlay-1')
    assertEquals(result.actual.remotePeerId, 'bob')
})

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAliceMissingProvider: {},
            },
        ],
        0,
        {
            rtcProviders: {},
        },
    )

    const result = report.resultsByName.connectAliceMissingProvider[0]

    assertEquals(report.summary.failure, 1)
    assertEquals(result.status, 'FAILURE')
    assertEquals(result.peerId, 'alice')
    assertEquals(result.groupId, 'group-1')
    assertEquals(result.overlayId, 'overlay-1')
    assertEquals(result.remotePeerId, 'bob')
    assertEquals(result.actual.peerId, 'alice')
    assertEquals(result.actual.groupId, 'group-1')
    assertEquals(result.actual.overlayId, 'overlay-1')
    assertEquals(result.actual.remotePeerId, 'bob')
})

Deno.test('createRallarRtcProviderFromRuntime supports scenario execution through runtime session', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: message => {
                    dispatcher.emitMessage(message)
                },
                close: () => {
                    dispatcher.emitClose({
                        reason: 'closed by runtime provider',
                    })
                },
            }
        },
    })

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello through runtime provider',
        },
    }

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        message: payload,
                    },
                },
                aliceSendsAndReceivesEcho: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSendsAndReceivesEcho[0].actual.matchedMessage.data, payload)
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
})

Deno.test('createRallarRtcProviderFromRuntime supports ordered expect.messages from runtime session', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: () => {
                    dispatcher.emitMessage({
                        topic: 'room.member.joined',
                        payload: {
                            actor: 'alice',
                        },
                    })
                    dispatcher.emitMessage({
                        topic: 'presence.update',
                        payload: {
                            actor: 'alice',
                            online: true,
                        },
                    })
                },
                close: () => {
                    dispatcher.emitClose({
                        reason: 'closed by runtime provider',
                    })
                },
            }
        },
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'trigger.join.flow',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        ordered: true,
                        consume: true,
                        messages: [
                            {
                                topic: 'room.member.joined',
                            },
                            {
                                topic: 'presence.update',
                            },
                        ],
                    },
                },
                aliceReceivesOrderedRuntimeMessages: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].actual.ordered, true)
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].actual.consumed, true)
    assertEquals(report.resultsByName.aliceReceivesOrderedRuntimeMessages[0].actual.matchedMessages.length, 2)
})

Deno.test('createRallarRtcProviderFromRuntime supports rtc.wait expect.close from runtime session', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: (_args, dispatcher) => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    dispatcher.emitClose({
                        reason: 'closed by runtime provider',
                    })
                },
            }
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
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
                        interactionExecutionNumber: 3,
                    },
                    response: {
                        connection: 'aliceRtc',
                        withinMs: 1000,
                        close: {
                            event: {
                                reason: 'closed by runtime provider',
                            },
                        },
                    },
                },
                waitForRuntimeClose: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForRuntimeClose[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForRuntimeClose[0].actual.matchedCloseEvent.event.reason, 'closed by runtime provider')
})

Deno.test('createRallarRtcProviderFromRuntime reports runtime connect failure through scenario result', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: () => {
            throw new Error('runtime connect failed')
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(report.resultsByName.connectAlice[0].actual.exception, 'runtime connect failed')
})

Deno.test('createRallarRtcProviderFromRuntime reports runtime send failure through scenario result', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: () => {
            return {
                send: () => {
                    throw new Error('runtime send failed')
                },
                close: () => {
                    // no-op
                },
            }
        },
    })

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
                        provider: 'rallar',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSends: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSends[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSends[0].result, 'RTC send failed')
    assertEquals(report.resultsByName.aliceSends[0].actual.exception, 'runtime send failed')
})

Deno.test('createRallarRtcProviderFromRuntime reports runtime close failure through scenario result', async () => {
    const provider = createRallarRtcProviderFromRuntime({
        connect: () => {
            return {
                send: () => {
                    // no-op
                },
                close: () => {
                    throw new Error('runtime close failed')
                },
            }
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                rallar: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.closeAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.closeAlice[0].result, 'RTC close failed')
    assertEquals(report.resultsByName.closeAlice[0].actual.exception, 'runtime close failed')
})

Deno.test('createRtcProviderFromClientFactory connects client and stores connection', async () => {
    let createdRequest: unknown
    let createdConfig: unknown
    let createdContext: unknown

    const fakeClient = createFakeRtcClient()

    const provider = createRtcProviderFromClientFactory({
        createClient: (request: any, config: any, context: any) => {
            createdRequest = request
            createdConfig = config
            createdContext = context
            return fakeClient
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.connectAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.connectAlice[0].actual.connected, true)
    assertEquals(fakeClient.connected, true)

    assertEquals((createdRequest as any).connection, 'aliceRtc')
    assertEquals((createdConfig as any).interactionName, 'connectAlice')
    assertEquals((createdContext as any).rtcProviders.fake !== undefined, true)
})

Deno.test('createRtcProviderFromClientFactory sends through connected client', async () => {
    const fakeClient = createFakeRtcClient()

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

    const payload = {
        topic: 'chat.message',
        payload: {
            text: 'hello',
        },
    }

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
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: payload,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSends: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(fakeClient.sentMessages, [payload])
    assertEquals(report.resultsByName.aliceSends[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.aliceSends[0].actual.sent, payload)
})

Deno.test('createRtcProviderFromClientFactory waits for client-emitted message', async () => {
    const fakeClient = createFakeRtcClient()

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        withinMs: 1000,
                        message: {
                            topic: 'chat.message',
                            payload: {
                                text: 'hello',
                            },
                        },
                    },
                },
                waitForMessage: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    setTimeout(() => {
        fakeClient.emitMessage({
            topic: 'chat.message',
            payload: {
                text: 'hello',
            },
        })
    }, 25)

    const report = await reportPromise

    assertEquals(report.summary.failure, 0)
    assertEquals(report.resultsByName.waitForMessage[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.waitForMessage[0].actual.matchedMessage.data, {
        topic: 'chat.message',
        payload: {
            text: 'hello',
        },
    })
})

Deno.test('createRtcProviderFromClientFactory closes client on rtc.close', async () => {
    const fakeClient = createFakeRtcClient()

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(fakeClient.closed, true)
    assertEquals(report.resultsByName.closeAlice[0].status, 'SUCCESS')
    assertEquals(report.resultsByName.closeAlice[0].actual.closed, true)
    assertEquals(report.rtcCloseEvents.aliceRtc.length >= 1, true)
})

Deno.test('createRtcProviderFromClientFactory converts connect exception to RTC failure result', async () => {
    const provider = createRtcProviderFromClientFactory({
        createClient: () => {
            throw new Error('cannot create client')
        },
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.connectAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.connectAlice[0].result, 'RTC connect failed')
    assertEquals(report.resultsByName.connectAlice[0].actual.exception, 'cannot create client')
})

Deno.test('createRtcProviderFromClientFactory converts send exception to RTC failure result', async () => {
    const fakeClient = createFakeRtcClient()
    fakeClient.send = async () => {
        throw new Error('send failed')
    }

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

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
                        provider: 'fake',
                        actor: 'alice',
                        roomId: 'room-1',
                        send: {
                            topic: 'chat.message',
                        },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                aliceSends: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.aliceSends[0].status, 'FAILURE')
    assertEquals(report.resultsByName.aliceSends[0].result, 'RTC send failed')
    assertEquals(report.resultsByName.aliceSends[0].actual.exception, 'send failed')
})

Deno.test('createRtcProviderFromClientFactory converts close exception to RTC failure result', async () => {
    const fakeClient = createFakeRtcClient()
    fakeClient.close = async () => {
        throw new Error('close failed')
    }

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
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
                        interactionExecutionNumber: 2,
                    },
                    response: {},
                },
                closeAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 1)
    assertEquals(report.resultsByName.closeAlice[0].status, 'FAILURE')
    assertEquals(report.resultsByName.closeAlice[0].result, 'RTC close failed')
    assertEquals(report.resultsByName.closeAlice[0].actual.exception, 'close failed')
})

Deno.test('createRtcProviderFromClientFactory auto-closes unclosed client connection', async () => {
    const fakeClient = createFakeRtcClient()

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(fakeClient.closed, true)
    assertEquals(report.rtcConnections, {})

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true)

    assertEquals(autoCloseEvent?.autoCloseRequested, true)
    assertEquals(autoCloseEvent?.autoCloseSucceeded, true)
})

Deno.test('createRtcProviderFromClientFactory records auto-close failure diagnostics', async () => {
    const fakeClient = createFakeRtcClient()
    fakeClient.close = async () => {
        throw new Error('auto close failed')
    }

    const provider = createRtcProviderFromClientFactory({
        createClient: () => fakeClient,
    })

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
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                connectAlice: {},
            },
        ],
        0,
        {
            rtcProviders: {
                fake: provider,
            },
        },
    )

    assertEquals(report.summary.failure, 0)
    assertEquals(report.rtcConnections, {})

    const autoCloseEvent = report.rtcCloseEvents.aliceRtc
        .find((event: any) => event.autoCloseRequested === true)

    assertEquals(autoCloseEvent?.autoCloseRequested, true)
    assertEquals(autoCloseEvent?.autoCloseSucceeded, false)
    assertEquals(autoCloseEvent?.autoCloseFailed, true)
    assertEquals(autoCloseEvent?.exception, 'auto close failed')
})
