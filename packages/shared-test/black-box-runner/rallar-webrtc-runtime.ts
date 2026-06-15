// rallar-webrtc-runtime.ts
// deno-lint-ignore-file no-explicit-any
import {
    createRallarRtcProviderFromRuntime,
    decodeRallarRtcMessage,
    encodeRallarRtcMessage,
    type RallarRtcClientArgs,
    type RallarRtcClientEventDispatcher,
    type RallarRtcRuntime,
    type RallarRtcRuntimeSession,
} from './rallar-rtc-provider.ts'

import type {RtcProvider} from './rtc-provider.ts'

export type RallarWebRtcRuntimeOptions = {
    createSession?: (
        args: RallarRtcClientArgs,
        dispatcher: RallarRtcClientEventDispatcher,
    ) => Promise<RallarRtcRuntimeSession> | RallarRtcRuntimeSession
}

export type RallarWebRtcSignalingTransportLike = {
    send: (data: string) => void
    close: () => void
    addEventListener?: (type: string, listener: (event: any) => void) => void
    onopen?: ((event: any) => void) | null
    onmessage?: ((event: any) => void) | null
    onclose?: ((event: any) => void) | null
    onerror?: ((event: any) => void) | null
    readyState?: string | number
}

export type RallarWebRtcWebSocketSignalingFactoryOptions = {
    createTransport: (args: RallarRtcClientArgs) => Promise<RallarWebRtcSignalingTransportLike> | RallarWebRtcSignalingTransportLike
    encode?: (message: any) => string
    decode?: (data: any) => any
    onConnectMessage?: (args: RallarRtcClientArgs) => any | undefined
    waitForOpen?: boolean
    openTimeoutMs?: number
}

export type RallarWebRtcWebSocketSignalingProviderOptions = Omit<
    RallarWebRtcWebSocketSignalingFactoryOptions,
    'createTransport'
>

function chainSignalingTransportListener(
    existing: ((event: any) => void) | null | undefined,
    listener: (event: any) => void,
): (event: any) => void {
    return event => {
        existing?.(event)
        listener(event)
    }
}

function addSignalingTransportListener(
    transport: RallarWebRtcSignalingTransportLike,
    type: string,
    listener: (event: any) => void,
): void {
    if (transport.addEventListener) {
        transport.addEventListener(type, listener)
        return
    }

    if (type === 'open') {
        transport.onopen = chainSignalingTransportListener(transport.onopen, listener)
        return
    }

    if (type === 'message') {
        transport.onmessage = chainSignalingTransportListener(transport.onmessage, listener)
        return
    }

    if (type === 'close') {
        transport.onclose = chainSignalingTransportListener(transport.onclose, listener)
        return
    }

    if (type === 'error') {
        transport.onerror = chainSignalingTransportListener(transport.onerror, listener)
    }
}

function isSignalingTransportOpen(transport: RallarWebRtcSignalingTransportLike): boolean {
    return transport.readyState === undefined || transport.readyState === 'open' || transport.readyState === 1
}

function shouldWaitForSignalingTransportOpen(
    options: RallarWebRtcWebSocketSignalingFactoryOptions,
    args: RallarRtcClientArgs,
): boolean {
    return options.waitForOpen === true || args.waitForOpen === true
}

function toSignalingTransportOpenTimeoutMs(
    options: RallarWebRtcWebSocketSignalingFactoryOptions,
    args: RallarRtcClientArgs,
): number {
    return options.openTimeoutMs || args.openTimeoutMs || args.connectTimeoutMs || args.timeoutMs || 5000
}

function waitForSignalingTransportOpen(
    transport: RallarWebRtcSignalingTransportLike,
    timeoutMs: number,
): Promise<void> {
    if (isSignalingTransportOpen(transport)) {
        return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
        let completed = false
        const startedAt = Date.now()

        const interval = setInterval(() => {
            if (isSignalingTransportOpen(transport)) {
                complete(resolve)
                return
            }

            if (Date.now() - startedAt >= timeoutMs) {
                complete(() => reject(new Error(
                    'Rallar WebRTC signaling transport did not open within ' + timeoutMs + 'ms. readyState=' + String(transport.readyState),
                )))
            }
        }, 25)

        const complete = (callback: () => void): void => {
            if (completed) {
                return
            }

            completed = true
            clearInterval(interval)
            callback()
        }

        addSignalingTransportListener(transport, 'open', () => {
            complete(resolve)
        })

        addSignalingTransportListener(transport, 'close', event => {
            complete(() => reject(new Error(
                'Rallar WebRTC signaling transport closed before open. readyState=' + String(transport.readyState) +
                ', code=' + String(event?.code) +
                ', reason=' + String(event?.reason),
            )))
        })

        addSignalingTransportListener(transport, 'error', event => {
            complete(() => reject(new Error(
                'Rallar WebRTC signaling transport failed before open. readyState=' + String(transport.readyState) +
                ', message=' + String(event?.message),
            )))
        })
    })
}

/**
 * Creates a signaling-session factory around a WebSocket-like transport.
 *
 * This layer owns only signaling transport concerns:
 * - encode/decode wire messages
 * - optional wait-for-open behavior
 * - optional on-connect/join message
 * - transport close/error/decode diagnostics
 *
 * It intentionally does not create RTCPeerConnection or RTCDataChannel instances.
 */
export function createRallarWebRtcWebSocketSignalingFactory(
    options: RallarWebRtcWebSocketSignalingFactoryOptions,
): RallarWebRtcSignalingFactory {
    return {
        connect: async args => {
            const transport = await options.createTransport(args)
            let opened = isSignalingTransportOpen(transport)
            const encode = options.encode || encodeRallarRtcMessage
            const decode = options.decode || decodeRallarRtcMessage
            const messageHandlers: Array<(message: any) => void> = []
            const closeHandlers: Array<(event: any) => void> = []

            addSignalingTransportListener(transport, 'message', event => {
                try {
                    const decoded = decode(event?.data)
                    messageHandlers.forEach(handler => handler(decoded))
                }
                catch (e) {
                    closeHandlers.forEach(handler => handler({
                        error: true,
                        phase: 'signaling-decode',
                        event,
                        message: e instanceof Error ? e.message : String(e),
                    }))
                }
            })

            addSignalingTransportListener(transport, 'close', event => {
                closeHandlers.forEach(handler => handler(event))
            })

            addSignalingTransportListener(transport, 'error', event => {
                closeHandlers.forEach(handler => handler({
                    error: true,
                    event,
                    message: event?.message,
                }))
            })

            if (shouldWaitForSignalingTransportOpen(options, args)) {
                await waitForSignalingTransportOpen(
                    transport,
                    toSignalingTransportOpenTimeoutMs(options, args),
                )
                opened = true
            }

            const onConnectMessage = options.onConnectMessage?.(args)
            if (onConnectMessage !== undefined) {
                transport.send(encode(onConnectMessage))
            }

            return {
                send: message => {
                    transport.send(encode(message))
                },
                close: () => {
                    transport.close()
                },
                onMessage: handler => {
                    messageHandlers.push(handler)
                },
                onClose: handler => {
                    closeHandlers.push(handler)
                },
                get opened() {
                    return opened
                },
                get readyState() {
                    return transport.readyState
                },
            }
        },
    }
}

function toRequiredSignalingUrl(args: RallarRtcClientArgs): string {
    if (!args.signalingUrl) {
        throw new Error('Rallar WebRTC signalingUrl is required for connection: ' + args.connection)
    }

    return args.signalingUrl
}

/**
 * The concrete `rallar-signaling` provider used by signaling-only CLI recipes.
 *
 * The legacy `rallar` provider name maps to this same implementation for
 * backward compatibility. It uses the global WebSocket implementation and is
 * still signaling-only.
 * A successful connect means the signaling transport opened; it does not mean
 * a WebRTC peer connection or data channel has been established yet.
 */
export function createRallarWebRtcWebSocketSignalingProvider(
    options: RallarWebRtcWebSocketSignalingProviderOptions = {},
): RtcProvider {
    return createRallarWebRtcSignalingOnlyProvider({
        signalingFactory: createRallarWebRtcWebSocketSignalingFactory({
            waitForOpen: true,
            ...options,
            createTransport: args => new WebSocket(toRequiredSignalingUrl(args)),
        }),
    })
}

export type RallarWebRtcSignalingSession = {
    send?: (message: any) => Promise<void> | void
    close: () => Promise<void> | void
    onMessage?: (handler: (message: any) => void) => void
    onClose?: (handler: (event: any) => void) => void
    opened?: boolean
    readyState?: string | number
}

export type RallarWebRtcSignalingFactory = {
    connect: (
        args: RallarRtcClientArgs,
        dispatcher: RallarRtcClientEventDispatcher,
    ) => Promise<RallarWebRtcSignalingSession> | RallarWebRtcSignalingSession
}

export type RallarWebRtcSignalingRuntimeOptions = {
    signalingFactory: RallarWebRtcSignalingFactory
}

function toMissingRuntimeImplementationError(args: RallarRtcClientArgs): Error {
    return new Error(
        'Rallar WebRTC runtime is not implemented yet. Missing createSession implementation for connection: ' + args.connection,
    )
}

/**
 * Runtime adapter that exposes a signaling session through the generic RTC
 * black-box provider contract.
 *
 * This is useful for testing and documenting Rallar signaling flows before the
 * real RTCPeerConnection/RTCDataChannel runtime exists.
 */
export function createRallarWebRtcSignalingOnlyRuntime(
    options: RallarWebRtcSignalingRuntimeOptions,
): RallarRtcRuntime {
    return {
        connect: async (args, dispatcher) => {
            const signalingSession = await options.signalingFactory.connect(args, dispatcher)

            signalingSession.onMessage?.(message => {
                dispatcher.emitMessage({
                    topic: 'rallar.webrtc.signaling.message',
                    connection: args.connection,
                    actor: args.actor,
                    peerId: args.peerId,
                    roomId: args.roomId,
                    groupId: args.groupId,
                    overlayId: args.overlayId,
                    message,
                })
            })

            signalingSession.onClose?.(event => {
                dispatcher.emitClose({
                    phase: 'signaling-close',
                    reason: 'rallar WebRTC signaling session closed',
                    closedBy: 'rallar-webrtc-signaling-only-runtime',
                    connection: args.connection,
                    actor: args.actor,
                    peerId: args.peerId,
                    roomId: args.roomId,
                    groupId: args.groupId,
                    overlayId: args.overlayId,
                    transportEvent: event,
                    event,
                })
            })

            dispatcher.emitMessage({
                topic: 'rallar.webrtc.signaling.connected',
                connection: args.connection,
                actor: args.actor,
                peerId: args.peerId,
                roomId: args.roomId,
                groupId: args.groupId,
                overlayId: args.overlayId,
                signalingUrl: args.signalingUrl,
                opened: signalingSession.opened,
                readyState: signalingSession.readyState,
            })

            return {
                send: async message => {
                    if (signalingSession.send) {
                        await signalingSession.send(message)
                        return
                    }

                    throw new Error(
                        'Rallar WebRTC data channel is not implemented yet. Signaling-only runtime cannot send RTC payload for connection: ' + args.connection,
                    )
                },

                close: async () => {
                    await signalingSession.close()
                    dispatcher.emitClose({
                        phase: 'close',
                        reason: 'closed by rallar WebRTC signaling-only runtime',
                        closedBy: 'rallar-webrtc-signaling-only-runtime',
                        connection: args.connection,
                        actor: args.actor,
                        peerId: args.peerId,
                        roomId: args.roomId,
                        groupId: args.groupId,
                        overlayId: args.overlayId,
                    })
                },
            }
        },
    }
}

/**
 * Provider wrapper for an injected signaling factory.
 *
 * Use this in tests when the signaling transport should be fake/in-memory.
 * Use `createRallarWebRtcWebSocketSignalingProvider()` for the explicit
 * `rallar-signaling` CLI path.
 */
export function createRallarWebRtcSignalingOnlyProvider(
    options: RallarWebRtcSignalingRuntimeOptions,
): RtcProvider {
    return createRallarRtcProviderFromRuntime(createRallarWebRtcSignalingOnlyRuntime(options))
}

/**
 * Placeholder/future real WebRTC runtime entry point.
 *
 * Today it requires an injected `createSession` implementation. The next major
 * phase should replace that injection with real RTCPeerConnection and
 * RTCDataChannel orchestration.
 */
export function createRallarWebRtcRuntime(options: RallarWebRtcRuntimeOptions = {}): RallarRtcRuntime {
    return {
        connect: async (args, dispatcher) => {
            if (!options.createSession) {
                throw toMissingRuntimeImplementationError(args)
            }

            return await options.createSession(args, dispatcher)
        },
    }
}

/**
 * Provider wrapper around `createRallarWebRtcRuntime(...)`.
 *
 * This is not the current CLI default. The CLI default is the WebSocket
 * signaling-only provider until real RTCPeerConnection support is implemented.
 */
export function createRallarWebRtcProvider(options: RallarWebRtcRuntimeOptions = {}): RtcProvider {
    return createRallarRtcProviderFromRuntime(createRallarWebRtcRuntime(options))
}
