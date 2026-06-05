// rallar-rtc-provider.ts
// deno-lint-ignore-file no-explicit-any
import { createRtcProviderFromClientFactory, type RtcClient, type RtcProvider, } from './rtc-provider.ts';

export type RallarRtcClientArgs = {
    connection: string
    provider: string
    actor?: string
    peerId?: string
    remotePeerId?: string
    roomId?: string
    groupId?: string
    overlayId?: string
    signalingUrl?: string
    signalingType?: string
    signalingHeaders?: any
    signalingProtocols?: string | string[]
    signaling?: any
    dataChannelLabel?: string
    iceServers?: any
    rtcConfig?: any
    metadata?: any
    timeoutMs?: number
    connectTimeoutMs?: number
    waitForOpen?: boolean
    openTimeoutMs?: number
    request: any
}

export type RallarRtcClientFactory = {
    createClient: (args: RallarRtcClientArgs, config?: any, context?: any) => Promise<RtcClient> | RtcClient
}

export type RallarRtcClientEventHandlers = {
    messageHandlers: Array<(message: any) => void>
    closeHandlers: Array<(event: any) => void>
}

export type RallarRtcClientEventDispatcher = {
    onMessage: (handler: (message: any) => void) => void
    onClose: (handler: (event: any) => void) => void
    emitMessage: (message: any) => void
    emitClose: (event: any) => void
    handlers: RallarRtcClientEventHandlers
}

export function createRallarRtcClientEventDispatcher(): RallarRtcClientEventDispatcher {
    const handlers: RallarRtcClientEventHandlers = {
        messageHandlers: [],
        closeHandlers: [],
    };

    return {
        onMessage(handler: (message: any) => void): void {
            handlers.messageHandlers.push(handler);
        },

        onClose(handler: (event: any) => void): void {
            handlers.closeHandlers.push(handler);
        },

        emitMessage(message: any): void {
            handlers.messageHandlers.forEach(handler => handler(message));
        },

        emitClose(event: any): void {
            handlers.closeHandlers.forEach(handler => handler(event));
        },

        handlers,
    };
}

export type RallarRtcClientOperations = {
    connect: (args: RallarRtcClientArgs, dispatcher: RallarRtcClientEventDispatcher) => Promise<void> | void
    send: (message: any, args: RallarRtcClientArgs, dispatcher: RallarRtcClientEventDispatcher) => Promise<void> | void
    close: (args: RallarRtcClientArgs, dispatcher: RallarRtcClientEventDispatcher) => Promise<void> | void
}

export function createRallarRtcClientFromOperations(
    args: RallarRtcClientArgs,
    operations: RallarRtcClientOperations,
): RtcClient {
    const dispatcher = createRallarRtcClientEventDispatcher()

    return {
        async connect(): Promise<void> {
            await operations.connect(args, dispatcher)
        },

        async send(message: any): Promise<void> {
            await operations.send(message, args, dispatcher)
        },

        async close(): Promise<void> {
            await operations.close(args, dispatcher)
        },

        onMessage(handler: (message: any) => void): void {
            dispatcher.onMessage(handler)
        },

        onClose(handler: (event: any) => void): void {
            dispatcher.onClose(handler)
        },
    }
}

export type RallarRtcRuntimeSession = {
    send: (message: any) => Promise<any> | any
    command?: (action: string, request: any) => Promise<any> | any
    close: () => Promise<void> | void
    connectDiagnostics?: any
}

export type RallarRtcRuntime = {
    connect: (
        args: RallarRtcClientArgs,
        dispatcher: RallarRtcClientEventDispatcher,
    ) => Promise<RallarRtcRuntimeSession> | RallarRtcRuntimeSession
}

export function encodeRallarRtcMessage(message: any): string {
    if (typeof message === 'string') {
        return message
    }

    const encoded = JSON.stringify(message)

    if (encoded === undefined) {
        throw new Error('Rallar RTC message cannot be encoded as JSON')
    }

    return encoded
}

export function decodeRallarRtcMessage(data: any): any {
    if (typeof data !== 'string') {
        return data
    }

    try {
        return JSON.parse(data)
    }
    catch (_ignored) {
        return data
    }
}

export type RallarRtcMessageCodec = {
    encode?: (message: any) => string
    decode?: (data: any) => any
}

function toMessageEncoder(factory: RallarRtcDataChannelFactory): (message: any) => string {
    return factory.codec?.encode || encodeRallarRtcMessage
}

function toMessageDecoder(factory: RallarRtcDataChannelFactory): (data: any) => any {
    return factory.codec?.decode || decodeRallarRtcMessage
}

function shouldWaitForDataChannelOpen(
    factory: RallarRtcDataChannelFactory,
    args: RallarRtcClientArgs,
): boolean {
    return factory.waitForOpen === true || args.waitForOpen === true
}

function toDataChannelOpenTimeoutMs(
    factory: RallarRtcDataChannelFactory,
    args: RallarRtcClientArgs,
): number {
    return factory.openTimeoutMs || args.openTimeoutMs || args.connectTimeoutMs || args.timeoutMs || 5000
}

export type RallarRtcDataChannelLike = {
    send: (data: string) => void
    close: () => void
    addEventListener?: (type: string, listener: (event: any) => void) => void
    onopen?: ((event: any) => void) | null
    onmessage?: ((event: any) => void) | null
    onclose?: ((event: any) => void) | null
    onerror?: ((event: any) => void) | null
    readyState?: string
}

export type RallarRtcDataChannelFactory = {
    connect: (
        args: RallarRtcClientArgs,
        dispatcher: RallarRtcClientEventDispatcher,
    ) => Promise<RallarRtcDataChannelLike> | RallarRtcDataChannelLike
    waitForOpen?: boolean
    openTimeoutMs?: number
    codec?: RallarRtcMessageCodec
}

function chainDataChannelListener(
    existing: ((event: any) => void) | null | undefined,
    listener: (event: any) => void,
): (event: any) => void {
    return event => {
        existing?.(event)
        listener(event)
    }
}

function addDataChannelListener(
    dataChannel: RallarRtcDataChannelLike,
    type: string,
    listener: (event: any) => void,
): void {
    if (dataChannel.addEventListener) {
        dataChannel.addEventListener(type, listener)
        return
    }

    if (type === 'open') {
        dataChannel.onopen = chainDataChannelListener(dataChannel.onopen, listener)
        return
    }

    if (type === 'message') {
        dataChannel.onmessage = chainDataChannelListener(dataChannel.onmessage, listener)
        return
    }

    if (type === 'close') {
        dataChannel.onclose = chainDataChannelListener(dataChannel.onclose, listener)
        return
    }

    if (type === 'error') {
        dataChannel.onerror = chainDataChannelListener(dataChannel.onerror, listener)
    }
}

function assertDataChannelOpen(dataChannel: RallarRtcDataChannelLike): void {
    if (dataChannel.readyState === undefined || dataChannel.readyState === 'open') {
        return
    }

    throw new Error('Rallar RTC data channel is not open. readyState=' + dataChannel.readyState)
}

function waitForDataChannelOpen(
    dataChannel: RallarRtcDataChannelLike,
    timeoutMs: number,
): Promise<void> {
    if (dataChannel.readyState === undefined || dataChannel.readyState === 'open') {
        return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
        let completed = false

        const startedAt = Date.now()

        const interval = setInterval(() => {
            if (dataChannel.readyState === 'open') {
                complete(resolve)
                return
            }

            if (Date.now() - startedAt >= timeoutMs) {
                complete(() => reject(new Error(
                    'Rallar RTC data channel did not open within ' + timeoutMs + 'ms. readyState=' + dataChannel.readyState,
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

        addDataChannelListener(dataChannel, 'open', () => {
            complete(resolve)
        })

        addDataChannelListener(dataChannel, 'close', event => {
            complete(() => reject(new Error(
                'Rallar RTC data channel closed before open. readyState=' + dataChannel.readyState +
                ', code=' + String(event?.code) +
                ', reason=' + String(event?.reason),
            )))
        })

        addDataChannelListener(dataChannel, 'error', event => {
            complete(() => reject(new Error(
                'Rallar RTC data channel failed before open. readyState=' + dataChannel.readyState +
                ', message=' + String(event?.message),
            )))
        })
    })
}

export function createRallarRtcRuntimeFromDataChannelFactory(
    factory: RallarRtcDataChannelFactory,
): RallarRtcRuntime {
    return {
        connect: async (args, dispatcher) => {
            const dataChannel = await factory.connect(args, dispatcher)

            const encode = toMessageEncoder(factory)
            const decode = toMessageDecoder(factory)

            addDataChannelListener(dataChannel, 'message', event => {
                try {
                    dispatcher.emitMessage(decode(event?.data))
                }
                catch (e) {
                    dispatcher.emitClose({
                        event,
                        error: true,
                        phase: 'decode',
                        message: e instanceof Error ? e.message : String(e),
                        readyState: dataChannel.readyState,
                    })
                }
            })

            addDataChannelListener(dataChannel, 'close', event => {
                dispatcher.emitClose({
                    event,
                    phase: 'close',
                    reason: event?.reason,
                    code: event?.code,
                    readyState: dataChannel.readyState,
                })
            })

            addDataChannelListener(dataChannel, 'error', event => {
                dispatcher.emitClose({
                    event,
                    error: true,
                    phase: 'error',
                    message: event?.message,
                    readyState: dataChannel.readyState,
                })
            })

            if (shouldWaitForDataChannelOpen(factory, args)) {
                await waitForDataChannelOpen(
                    dataChannel,
                    toDataChannelOpenTimeoutMs(factory, args),
                )
            }

            return {
                send: message => {
                    assertDataChannelOpen(dataChannel)
                    dataChannel.send(encode(message))
                },
                close: () => {
                    dataChannel.close()
                },
            }
        },
    }
}

export function createRallarRtcClientFromRuntime(
    args: RallarRtcClientArgs,
    runtime: RallarRtcRuntime,
): RtcClient {
    let session: RallarRtcRuntimeSession | undefined

    return createRallarRtcClientFromOperations(args, {
        connect: async (operationArgs, dispatcher) => {
            session = await runtime.connect(operationArgs, dispatcher)
        },

        send: async message => {
            if (!session) {
                throw new Error(
                    'Rallar RTC client is not connected for connection: ' + args.connection,
                )
            }

            await session.send(message)
        },

        close: async () => {
            if (!session) {
                return
            }

            await session.close()
            session = undefined
        },
    })
}

export function createUnimplementedRallarRtcClient(args: RallarRtcClientArgs): RtcClient {
    const unimplemented = (operation: string): Error => {
        return new Error(
            'Rallar RTC client operation is not implemented yet: ' + operation +
            ' for connection: ' + args.connection,
        )
    }

    return createRallarRtcClientFromOperations(args, {
        connect: () => {
            throw unimplemented('connect')
        },

        send: () => {
            throw unimplemented('send')
        },

        close: () => {
            throw unimplemented('close')
        },
    })
}

function firstDefined(...values: any[]): any {
    return values.find(value => value !== undefined);
}

function toConnectionName(request: any): string {
    return String(firstDefined(
        request.connection,
        request.connectionId,
        request.actor,
        request.peerId,
        request.clientId,
        'default',
    ));
}

function toProviderName(request: any): string {
    return String(firstDefined(request.provider, 'rallar'));
}

function toPeerId(request: any): string | undefined {
    return firstDefined(
        request.peerId,
        request.localPeerId,
        request.clientId,
        request.actor,
        request.connection,
    );
}

function toRemotePeerId(request: any): string | undefined {
    return firstDefined(
        request.remotePeerId,
        request.targetPeerId,
        request.toPeerId,
        request.targetActor,
        request.toActor,
    );
}

function toGroupId(request: any): string | undefined {
    return firstDefined(request.groupId, request.overlayId, request.roomId);
}

function toOverlayId(request: any): string | undefined {
    return firstDefined(request.overlayId, request.groupId, request.roomId);
}

function toSignalingUrl(request: any): string | undefined {
    return firstDefined(
        request.signalingUrl,
        request.signaling?.url,
        request.signaling?.wsUrl,
        request.signaling?.webSocketUrl,
        request.signaling?.path,
    );
}

function toSignalingType(request: any): string | undefined {
    return firstDefined(request.signalingType, request.signaling?.type);
}

function toSignalingHeaders(request: any): any {
    return firstDefined(request.signalingHeaders, request.signaling?.headers);
}

function toSignalingProtocols(request: any): string | string[] | undefined {
    return firstDefined(request.signalingProtocols, request.signaling?.protocols, request.signaling?.protocol);
}

function toIceServers(request: any): any {
    return firstDefined(
        request.iceServers,
        request.rtcConfig?.iceServers,
        request.ice?.servers,
        request.signaling?.iceServers,
    );
}

function toConnectTimeoutMs(request: any): number | undefined {
    return firstDefined(request.connectTimeoutMs, request.timeoutMs);
}

function toWaitForOpen(request: any): boolean | undefined {
    return firstDefined(request.waitForOpen, request.dataChannel?.waitForOpen, request.channel?.waitForOpen)
}

function toOpenTimeoutMs(request: any): number | undefined {
    return firstDefined(
        request.openTimeoutMs,
        request.dataChannel?.openTimeoutMs,
        request.channel?.openTimeoutMs,
        request.connectTimeoutMs,
        request.timeoutMs,
    )
}

function toDataChannelLabel(request: any): string {
    return String(firstDefined(
        request.dataChannelLabel,
        request.channelLabel,
        request.channel?.label,
        'rallar',
    ));
}

export function toRallarRtcClientArgs(request: any): RallarRtcClientArgs {
    return {
        connection: toConnectionName(request),
        provider: toProviderName(request),
        actor: request.actor,
        peerId: toPeerId(request),
        remotePeerId: toRemotePeerId(request),
        roomId: request.roomId,
        groupId: toGroupId(request),
        overlayId: toOverlayId(request),
        signalingUrl: toSignalingUrl(request),
        signalingType: toSignalingType(request),
        signalingHeaders: toSignalingHeaders(request),
        signalingProtocols: toSignalingProtocols(request),
        signaling: request.signaling,
        dataChannelLabel: toDataChannelLabel(request),
        iceServers: toIceServers(request),
        rtcConfig: request.rtcConfig,
        metadata: request.metadata,
        timeoutMs: request.timeoutMs,
        connectTimeoutMs: toConnectTimeoutMs(request),
        waitForOpen: toWaitForOpen(request),
        openTimeoutMs: toOpenTimeoutMs(request),
        request,
    };
}

export function createRallarRtcProvider(factory: RallarRtcClientFactory): RtcProvider {
    return createRtcProviderFromClientFactory({
        createClient: (request, config, context) => {
            return factory.createClient(toRallarRtcClientArgs(request), config, context);
        },
    });
}

export function createRallarRtcProviderFromRuntime(runtime: RallarRtcRuntime): RtcProvider {
    return createRallarRtcProvider({
        createClient: args => createRallarRtcClientFromRuntime(args, runtime),
    })
}

export function createRallarRtcProviderFromDataChannelFactory(
    factory: RallarRtcDataChannelFactory,
): RtcProvider {
    return createRallarRtcProviderFromRuntime(
        createRallarRtcRuntimeFromDataChannelFactory(factory),
    )
}

export function createUnimplementedRallarRtcProvider(): RtcProvider {
    return createRallarRtcProvider({
        createClient: args => createUnimplementedRallarRtcClient(args),
    });
}
