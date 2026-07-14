import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    RallarRealtimeBinarySendInput,
    RallarRealtimeHandler,
    RallarRealtimeHealthOptions,
    RallarRealtimeJsonLane,
    RallarRealtimeJsonLaneDefaults,
    RallarRealtimeJsonLaneSendOptions,
    RallarRealtimeJsonSendInput,
    RallarRealtimeLaneHealth,
    RallarRealtimeMessage,
    RallarRealtimeSendOptions,
    RallarRealtimeSendResult,
    RallarRoomRealtimeJsonChannel,
    RallarRoomRealtimeJsonDefaults,
    RallarRoomRealtimeJsonSendOptions,
    RallarRoomRealtimeSendResult,
    RallarRoomRealtimeSendStatus,
    RallarRoomRealtimeTransportOptions,
    RallarRtcRoomLaneWaitResult,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetedChannelSendOptions,
    RallarTargetedSendStatus,
    RallarTargetSelector,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar-facade-contract.ts';
import type { CreateRallarRealtimeFacadeOptions } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    isGroupActive,
    isSessionInGroup,
} from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
    type QRtcPeerDto,
    type WebRtcPeerLaneOpenResult,
} from '@shared/services/WebRtcConnectionService.ts';
import type {
    RtcDataChannelSendOptions,
    RtcDataChannelSendResult,
} from '@shared/webrtc/QRtcDataChannel.ts';

const RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID = 'rallar:realtime:lifecycle';

export type CreateRallarRealtimeControllerOptions = Readonly<{
    connect(): Promise<ApiMiddleware>;
    readMiddleware(): ApiMiddleware | undefined;
    readSession(): AuthSession | undefined;
    readDefaultRoom(): string | GroupRef | undefined;
    readCurrentRoomRef(): GroupRef | undefined;
    readCurrentRoomSnapshot(): GroupSnapshot | undefined;
    findGroupSnapshot(room: string | GroupRef): GroupSnapshot | undefined;
    resolveRoomPeerIds(room: string | GroupRef): readonly string[];
    resolveLaneId(laneId?: string): string;
    resolveOpenTimeoutMs(openTimeoutMs?: number): number;
    rtc: RallarRtcFacade;
}>;

export type RallarRealtimeController = Readonly<{
    operations: CreateRallarRealtimeFacadeOptions;
    createTargetedChannel<T>(
        definition: RallarTargetedChannelDefinition,
    ): RallarTargetedChannel<T>;
    resolveTargetPeerIds(input?: RallarTargetSelector): readonly string[];
    attachPeerLifecycle(ctx: ApiMiddleware): void;
    detachPeerLifecycle(ctx?: ApiMiddleware): void;
    attachLaneCallbacks(): void;
    detachLaneCallbacks(ctx?: ApiMiddleware): void;
}>;

export function createRallarRealtimeController(
    options: CreateRallarRealtimeControllerOptions,
): RallarRealtimeController {
    const jsonListeners = new Map<
        string,
        Set<RallarRealtimeHandler<unknown>>
    >();
    const binaryListeners = new Map<
        string,
        Set<RallarRealtimeHandler<ArrayBuffer>>
    >();

    const laneIds = (): readonly string[] => [
        ...new Set([
            ...jsonListeners.keys(),
            ...binaryListeners.keys(),
        ]),
    ];

    const callbackId = (laneId: string): string =>
        `rallar:realtime:${laneId}`;

    const registerCallbacksForPeer = (
        peer: QRtcPeerDto,
        laneId?: string,
    ): void => {
        const selectedLaneIds = laneId ? [laneId] : laneIds();
        for (const currentLaneId of selectedLaneIds) {
            const channel = peer.channels.get(currentLaneId);
            if (!channel) {
                continue;
            }

            channel.onRawMessageDo(callbackId(currentLaneId), {
                onMessage: async (data, event) => {
                    await dispatchMessage(
                        peer.peerId,
                        currentLaneId,
                        data,
                        event,
                    );
                },
            });
        }
    };

    const registerLaneCallbacks = (laneId: string): void => {
        const ctx = options.readMiddleware();
        if (!ctx) {
            return;
        }

        for (const peerId of ctx.middleware.webRtcConnectionService.activePeerIds()) {
            const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
            if (peer) {
                registerCallbacksForPeer(peer, laneId);
            }
        }
    };

    const notifyListeners = async <T>(
        listeners: Set<RallarRealtimeHandler<T>>,
        message: RallarRealtimeMessage<T>,
    ): Promise<void> => {
        await Promise.all(
            [...listeners].map(async (listener) => {
                try {
                    await listener(message);
                } catch (error) {
                    console.error(
                        'Error notifying Rallar realtime listener',
                        error,
                    );
                }
            }),
        );
    };

    const dispatchJson = async (
        peerId: string,
        laneId: string,
        data: string,
        event: MessageEvent,
    ): Promise<void> => {
        const listeners = jsonListeners.get(laneId);
        if (!listeners || listeners.size === 0) {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch (error) {
            console.error('Error parsing Rallar realtime JSON message', error);
            return;
        }

        await notifyListeners(listeners, {
            peerId,
            laneId,
            data: parsed,
            event,
            receivedAtEpochMs: Date.now(),
        });
    };

    const dispatchBinary = async (
        peerId: string,
        laneId: string,
        data: MessageEvent['data'],
        event: MessageEvent,
    ): Promise<void> => {
        const listeners = binaryListeners.get(laneId);
        if (!listeners || listeners.size === 0) {
            return;
        }

        const bytes = await toArrayBuffer(data);
        if (!bytes) {
            return;
        }

        await notifyListeners(listeners, {
            peerId,
            laneId,
            data: bytes,
            event,
            receivedAtEpochMs: Date.now(),
        });
    };

    const dispatchMessage = async (
        peerId: string,
        laneId: string,
        data: MessageEvent['data'],
        event: MessageEvent,
    ): Promise<void> => {
        if (typeof data === 'string') {
            await dispatchJson(peerId, laneId, data, event);
            return;
        }

        await dispatchBinary(peerId, laneId, data, event);
    };

    const deleteLaneIfUnused = (laneId: string): void => {
        const jsonLaneListeners = jsonListeners.get(laneId);
        if (jsonLaneListeners?.size === 0) {
            jsonListeners.delete(laneId);
        }

        const binaryLaneListeners = binaryListeners.get(laneId);
        if (binaryLaneListeners?.size === 0) {
            binaryListeners.delete(laneId);
        }

        if (jsonListeners.has(laneId) || binaryListeners.has(laneId)) {
            return;
        }

        const ctx = options.readMiddleware();
        if (!ctx) {
            return;
        }

        for (const peerId of ctx.middleware.webRtcConnectionService.knownPeerIds()) {
            ctx.middleware.webRtcConnectionService
                .readPeer(peerId)
                ?.channels.get(laneId)
                ?.removeOnRawMessageCallbackById(callbackId(laneId));
        }
    };

    const onJson = <T = unknown>(
        laneId: string,
        handler: RallarRealtimeHandler<T>,
    ): RallarUnsubscribe => {
        const listeners = jsonListeners.get(laneId) ??
            new Set<RallarRealtimeHandler<unknown>>();
        listeners.add(handler as RallarRealtimeHandler<unknown>);
        jsonListeners.set(laneId, listeners);
        registerLaneCallbacks(laneId);

        return () => {
            listeners.delete(handler as RallarRealtimeHandler<unknown>);
            deleteLaneIfUnused(laneId);
        };
    };

    const onBinary = (
        laneId: string,
        handler: RallarRealtimeHandler<ArrayBuffer>,
    ): RallarUnsubscribe => {
        const listeners = binaryListeners.get(laneId) ??
            new Set<RallarRealtimeHandler<ArrayBuffer>>();
        listeners.add(handler);
        binaryListeners.set(laneId, listeners);
        registerLaneCallbacks(laneId);

        return () => {
            listeners.delete(handler);
            deleteLaneIfUnused(laneId);
        };
    };

    const resolveRealtimePeerIds = (
        input: RallarRealtimeSendOptions,
    ): readonly string[] => {
        const session = options.readSession();
        if (input.peerIds) {
            return [...new Set(input.peerIds)]
                .filter((sessionId) => sessionId !== session?.sessionId);
        }

        const defaultRoom = options.readDefaultRoom();
        const room = input.roomRef
            ? options.findGroupSnapshot(input.roomRef)
            : input.roomId
                ? options.findGroupSnapshot(input.roomId)
                : defaultRoom
                    ? options.findGroupSnapshot(defaultRoom)
                    : options.readCurrentRoomSnapshot();

        const peerIds = (room?.activeSessions ?? [])
            .map((activeSession) => activeSession.sessionId)
            .filter((sessionId) => sessionId !== session?.sessionId);

        return [...new Set(peerIds)];
    };

    const ensureLaneOpen = async (
        ctx: ApiMiddleware,
        peerId: string,
        laneId: string,
        input: RallarRealtimeSendOptions,
    ): Promise<WebRtcPeerLaneOpenResult> =>
        await ctx.middleware.webRtcConnectionService.ensurePeerLaneOpen(
            peerId,
            laneId,
            { timeoutMs: options.resolveOpenTimeoutMs(input.openTimeoutMs) },
        );

    const sendJson = async <T>(
        input: RallarRealtimeJsonSendInput<T>,
    ): Promise<readonly RallarRealtimeSendResult[]> => {
        const ctx = await options.connect();
        const laneId = options.resolveLaneId(input.laneId);
        const peerIds = resolveRealtimePeerIds(input);

        return await Promise.all(
            peerIds.map(async (peerId) => {
                const laneOpen = await ensureLaneOpen(ctx, peerId, laneId, input);
                return {
                    peerId,
                    laneId,
                    result: laneOpen.status === 'open' && laneOpen.channel
                        ? laneOpen.channel.sendJson(
                            input.data,
                            toRealtimeDataChannelSendOptions(input),
                        )
                        : toClosedRealtimeSendResult(),
                };
            }),
        );
    };

    const sendBinary = async (
        input: RallarRealtimeBinarySendInput,
    ): Promise<readonly RallarRealtimeSendResult[]> => {
        const ctx = await options.connect();
        const laneId = options.resolveLaneId(input.laneId);
        const peerIds = resolveRealtimePeerIds(input);

        return await Promise.all(
            peerIds.map(async (peerId) => {
                const laneOpen = await ensureLaneOpen(ctx, peerId, laneId, input);
                return {
                    peerId,
                    laneId,
                    result: laneOpen.status === 'open' && laneOpen.channel
                        ? laneOpen.channel.sendBinary(
                            input.data,
                            toRealtimeDataChannelSendOptions(input),
                        )
                        : toClosedRealtimeSendResult(),
                };
            }),
        );
    };

    let operations: CreateRallarRealtimeFacadeOptions;

    const createJsonLane = <T>(
        defaults: RallarRealtimeJsonLaneDefaults,
    ): RallarRealtimeJsonLane<T> => {
        const laneId = options.resolveLaneId(defaults.laneId);
        return {
            send: async (
                data,
                sendOptions: RallarRealtimeJsonLaneSendOptions<T> = {},
            ) => await operations.sendJson<T>({
                ...defaults,
                ...sendOptions,
                data,
            }),
            on: (handler) => operations.onJson<T>(laneId, handler),
        };
    };

    const resolveRoomTarget = (
        defaults: Readonly<{ roomId?: string; roomRef?: GroupRef }>,
        roomOptions: Readonly<{ roomId?: string; roomRef?: GroupRef }>,
    ): string | GroupRef | undefined =>
        roomOptions.roomRef ?? roomOptions.roomId ??
        defaults.roomRef ?? defaults.roomId ??
        options.readDefaultRoom() ?? options.readCurrentRoomRef();

    const sendRoomJson = async <T>(
        defaults: RallarRoomRealtimeJsonDefaults,
        data: T,
        sendOptions: RallarRoomRealtimeJsonSendOptions<T>,
    ): Promise<RallarRoomRealtimeSendResult> => {
        const laneId = options.resolveLaneId(
            sendOptions.laneId ?? defaults.laneId,
        );
        const room = resolveRoomTarget(defaults, sendOptions);
        if (!room) {
            return {
                transport: 'rtc',
                status: 'no-targets',
                laneId,
                peerIds: [],
                desiredPeerIds: [],
                results: [],
                reason: 'Cannot send room realtime payload without a room.',
            };
        }

        await options.connect();
        let transportStatus = options.rtc.roomStatus(room, {
            laneId,
            minReadyPeers: sendOptions.minReadyPeers ?? defaults.minReadyPeers,
        });
        let readiness: RallarRtcRoomLaneWaitResult | undefined;
        let readyPeerIds = transportStatus.rtc.readyPeerIds;
        const waitForReady = sendOptions.waitForReady ??
            defaults.waitForReady ?? true;

        if (readyPeerIds.length === 0 && waitForReady) {
            readiness = await options.rtc.waitForRoomLane(room, laneId, {
                connect: sendOptions.connect ?? defaults.connect ?? true,
                timeoutMs: sendOptions.waitTimeoutMs ??
                    defaults.waitTimeoutMs ??
                    sendOptions.openTimeoutMs ?? defaults.openTimeoutMs,
                signal: sendOptions.signal,
                roomRef: typeof room === 'string' ? undefined : room,
            });
            readyPeerIds = uniquePeerIds(
                readiness.ready.map((ready) => ready.peerId),
            );
            transportStatus = options.rtc.roomStatus(room, {
                laneId,
                minReadyPeers: sendOptions.minReadyPeers ?? defaults.minReadyPeers,
            });
        }

        const desiredPeerIds = transportStatus.rtc.desiredPeerIds;
        if (desiredPeerIds.length === 0) {
            return {
                transport: 'rtc',
                status: 'no-targets',
                laneId,
                roomId: transportStatus.roomId,
                roomRef: transportStatus.roomRef,
                peerIds: [],
                desiredPeerIds,
                readiness,
                transportStatus,
                results: [],
                reason: 'Room has no RTC peer targets.',
            };
        }

        if (readyPeerIds.length === 0) {
            return {
                transport: 'rtc',
                status: 'not-ready',
                laneId,
                roomId: transportStatus.roomId,
                roomRef: transportStatus.roomRef,
                peerIds: [],
                desiredPeerIds,
                readiness,
                transportStatus,
                results: [],
                reason: readiness?.status
                    ? `Room RTC wait ended with ${readiness.status}.`
                    : 'Room RTC has no ready peers.',
            };
        }

        const {
            connect: _connect,
            minReadyPeers: _minReadyPeers,
            waitForReady: _waitForReady,
            waitTimeoutMs: _waitTimeoutMs,
            ...defaultSendOptions
        } = defaults;
        const {
            connect: _optionConnect,
            minReadyPeers: _optionMinReadyPeers,
            signal: _optionSignal,
            waitForReady: _optionWaitForReady,
            waitTimeoutMs: _optionWaitTimeoutMs,
            ...resolvedSendOptions
        } = sendOptions;
        const results = await sendJson<T>({
            ...defaultSendOptions,
            ...resolvedSendOptions,
            laneId,
            roomId: transportStatus.roomRef ? undefined : transportStatus.roomId,
            roomRef: transportStatus.roomRef,
            peerIds: readyPeerIds,
            data,
        });

        return {
            transport: 'rtc',
            status: toRoomRealtimeSendStatus(
                desiredPeerIds,
                readyPeerIds,
                results,
            ),
            laneId,
            roomId: transportStatus.roomId,
            roomRef: transportStatus.roomRef,
            peerIds: readyPeerIds,
            desiredPeerIds,
            readiness,
            transportStatus,
            results,
        };
    };

    const createRoomChannel = <T>(
        defaults: RallarRoomRealtimeJsonDefaults,
    ): RallarRoomRealtimeJsonChannel<T> => {
        const laneId = options.resolveLaneId(defaults.laneId);
        return {
            send: async (
                data,
                sendOptions: RallarRoomRealtimeJsonSendOptions<T> = {},
            ) => await sendRoomJson(defaults, data, sendOptions),
            on: (handler) => operations.onJson<T>(laneId, handler),
            status: (roomOptions: RallarRoomRealtimeTransportOptions = {}) => {
                const room = resolveRoomTarget(defaults, roomOptions);
                if (!room) {
                    throw new Error(
                        'Cannot read room realtime status without a room.',
                    );
                }
                return options.rtc.roomStatus(room, {
                    ...roomOptions,
                    laneId: options.resolveLaneId(
                        roomOptions.laneId ?? defaults.laneId,
                    ),
                });
            },
            wait: async (
                roomOptions: RallarRoomRealtimeTransportOptions = {},
            ) => {
                const room = resolveRoomTarget(defaults, roomOptions);
                if (!room) {
                    throw new Error(
                        'Cannot wait for room realtime without a room.',
                    );
                }
                return await options.rtc.waitForRoom(room, {
                    ...roomOptions,
                    laneId: options.resolveLaneId(
                        roomOptions.laneId ?? defaults.laneId,
                    ),
                    connect: roomOptions.connect ?? defaults.connect ?? true,
                    timeoutMs: roomOptions.timeoutMs ?? defaults.waitTimeoutMs,
                    minReadyPeers: roomOptions.minReadyPeers ??
                        defaults.minReadyPeers,
                });
            },
        };
    };

    const resolveTargetPeerIds = (
        input: RallarTargetSelector = {},
    ): readonly string[] => {
        const session = options.readSession();
        const explicitPeerIds = input.peerIds ??
            (input.peerId ? [input.peerId] : undefined);
        if (explicitPeerIds) {
            return [...new Set(explicitPeerIds)]
                .filter((peerId) => peerId !== session?.sessionId);
        }

        const room = input.roomRef ?? input.roomId ??
            options.readDefaultRoom() ?? options.readCurrentRoomRef();
        return room ? options.resolveRoomPeerIds(room) : [];
    };

    const createTargetedChannel = <T>(
        definition: RallarTargetedChannelDefinition,
    ): RallarTargetedChannel<T> => {
        const fixedPeerIds = definition.membership === 'live'
            ? undefined
            : resolveTargetPeerIds(definition);
        const defaultLaneId = options.resolveLaneId(definition.laneId);
        const resolvePeerIds = (
            targetOptions: RallarTargetSelector = {},
        ): readonly string[] => {
            if (fixedPeerIds && !hasTargetSelectorOverride(targetOptions)) {
                return fixedPeerIds;
            }
            return resolveTargetPeerIds({ ...definition, ...targetOptions });
        };

        return {
            send: async (
                data,
                sendOptions: RallarTargetedChannelSendOptions<T> = {},
            ) => {
                const laneId = options.resolveLaneId(
                    sendOptions.laneId ?? definition.laneId,
                );
                const peerIds = resolvePeerIds(sendOptions);
                if (peerIds.length === 0) {
                    return {
                        transport: 'rtc',
                        status: 'no-targets',
                        laneId,
                        peerIds,
                        results: [],
                        reason: 'No target RTC peers resolved.',
                    };
                }

                const results = await sendJson<T>({
                    ...definition,
                    ...sendOptions,
                    laneId,
                    peerIds,
                    data,
                });
                return {
                    transport: 'rtc',
                    status: toTargetedSendStatus(peerIds, results),
                    laneId,
                    peerIds,
                    results,
                };
            },
            on: (handler) => operations.onJson<T>(defaultLaneId, handler),
            peerIds: resolvePeerIds,
        };
    };

    operations = {
        sendJson,
        sendBinary,
        onJson,
        onBinary,
        json: createJsonLane,
        room: createRoomChannel,
        health: (healthOptions: RallarRealtimeHealthOptions = {}):
            readonly RallarRealtimeLaneHealth[] => {
            const ctx = options.readMiddleware();
            if (!ctx) {
                return [];
            }
            const peerIds = healthOptions.peerIds ??
                ctx.middleware.webRtcConnectionService.activePeerIds();
            return peerIds.flatMap((peerId) => {
                const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
                if (!peer) {
                    return [];
                }
                const selectedLaneIds = healthOptions.laneIds ??
                    Array.from(peer.channels.keys());
                return selectedLaneIds.map((laneId) => ({
                    peerId,
                    laneId,
                    channel: peer.channels.get(laneId)?.readHealth(),
                }));
            });
        },
    };

    return {
        operations,
        createTargetedChannel,
        resolveTargetPeerIds,
        attachPeerLifecycle: (ctx) => {
            ctx.middleware.webRtcConnectionService.onRtcPeerLifecycleDo(
                RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID,
                {
                    onCreated: (peer) => registerCallbacksForPeer(peer),
                    onDeleted: (peer) => {
                        for (const laneId of laneIds()) {
                            peer.channels.get(laneId)
                                ?.removeOnRawMessageCallbackById(
                                    callbackId(laneId),
                                );
                        }
                    },
                },
            );
        },
        detachPeerLifecycle: (ctx = options.readMiddleware()) => {
            if (!ctx) {
                return;
            }
            ctx.middleware.webRtcConnectionService.removeRtcPeerLifecycleById(
                RALLAR_REALTIME_LIFECYCLE_CALLBACK_ID,
            );
        },
        attachLaneCallbacks: () => {
            for (const laneId of laneIds()) {
                registerLaneCallbacks(laneId);
            }
        },
        detachLaneCallbacks: (ctx = options.readMiddleware()) => {
            if (!ctx) {
                return;
            }
            for (const peerId of ctx.middleware.webRtcConnectionService.knownPeerIds()) {
                const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
                if (!peer) {
                    continue;
                }
                for (const laneId of laneIds()) {
                    peer.channels.get(laneId)
                        ?.removeOnRawMessageCallbackById(callbackId(laneId));
                }
            }
        },
    };
}

function toRealtimeDataChannelSendOptions(
    input: RallarRealtimeSendOptions,
): RtcDataChannelSendOptions {
    return {
        key: input.key,
        maxAgeMs: input.maxAgeMs,
        now: input.now,
    };
}

function toClosedRealtimeSendResult(): RtcDataChannelSendResult {
    return {
        status: 'closed',
        reason: 'Realtime lane not connected',
        bufferedAmount: 0,
    };
}

async function toArrayBuffer(
    data: MessageEvent['data'],
): Promise<ArrayBuffer | undefined> {
    if (data instanceof ArrayBuffer) {
        return data;
    }
    if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );
        return bytes.slice().buffer;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return await data.arrayBuffer();
    }
    return undefined;
}

function hasTargetSelectorOverride(input: RallarTargetSelector): boolean {
    return input.peerId !== undefined || input.peerIds !== undefined ||
        input.roomId !== undefined || input.roomRef !== undefined ||
        input.membership !== undefined;
}

function toTargetedSendStatus(
    peerIds: readonly string[],
    results: readonly RallarRealtimeSendResult[],
): RallarTargetedSendStatus {
    if (peerIds.length === 0) {
        return 'no-targets';
    }
    const sentCount = results.filter((result) =>
        isAcceptedRealtimeSendStatus(result.result.status)
    ).length;
    if (sentCount === peerIds.length) {
        return 'sent';
    }
    return sentCount > 0 ? 'partial' : 'failed';
}

function toRoomRealtimeSendStatus(
    desiredPeerIds: readonly string[],
    peerIds: readonly string[],
    results: readonly RallarRealtimeSendResult[],
): RallarRoomRealtimeSendStatus {
    if (desiredPeerIds.length === 0) {
        return 'no-targets';
    }
    if (peerIds.length === 0) {
        return 'not-ready';
    }
    const sentCount = results.filter((result) =>
        isAcceptedRealtimeSendStatus(result.result.status)
    ).length;
    if (sentCount === 0) {
        return 'failed';
    }
    return sentCount >= desiredPeerIds.length ? 'sent' : 'partial';
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}

function isAcceptedRealtimeSendStatus(
    status: RtcDataChannelSendResult['status'],
): boolean {
    return status === 'sent' || status === 'queued' || status === 'replaced';
}

export function resolveActiveRoomPeerIds(
    session: AuthSession | undefined,
    snapshot: GroupSnapshot | undefined,
): readonly string[] {
    if (
        !session || !snapshot || !isGroupActive(snapshot) ||
        !isSessionInGroup(snapshot, session.sessionId)
    ) {
        return [];
    }
    return [...new Set(
        snapshot.activeSessions
            .map((activeSession) => activeSession.sessionId)
            .filter((sessionId) => sessionId !== session.sessionId),
    )];
}

export { DEFAULT_RTC_DATA_CHANNEL_LANE_ID };
