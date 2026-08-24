import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    CreateRallarCallsFacadeOptions,
    RallarCallEndOptions,
    RallarCallHandle,
    RallarCallInviteInput,
    RallarCallInviteListener,
    RallarCallInviteResult,
    RallarCallParticipantState,
    RallarCallParticipantStatus,
    RallarCallSignalEvent,
    RallarCallSignalKind,
    RallarCallSignalListener,
    RallarCallSignalPayload,
    RallarCallSignalSend,
    RallarCallStartInput,
    RallarCallState,
    RallarCallStatus,
    RallarCallWaitOptions,
    RallarIncomingCallInvite
} from '@shared-web/browser/rallar-calls-facade.ts';
import type { RallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarMessage, RallarMessageSendResult } from '@shared-web/browser/rallar-message-contracts.ts';
import type {
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
    RallarTargetSelector
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRtcFacade,
    RallarRtcLaneStatus,
    RallarRtcPeerStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarMediaPort } from '@shared-web/browser/rallar-runtime/media.ts';
import type { RallarMessagesController } from '@shared-web/browser/rallar-runtime/messages.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';

const RALLAR_CALL_SIGNAL_TOPIC_ID = 'app.rallar.calls';
const RALLAR_CALL_INVITE_TYPE_ID = 'app.rallar.calls.invite.v1';
const RALLAR_CALL_ACCEPT_TYPE_ID = 'app.rallar.calls.accept.v1';
const RALLAR_CALL_DECLINE_TYPE_ID = 'app.rallar.calls.decline.v1';
const RALLAR_CALL_CANCEL_TYPE_ID = 'app.rallar.calls.cancel.v1';

export type CreateRallarCallsControllerOptions = Readonly<{
    connect(): Promise<ApiMiddleware>;
    readMiddleware(): ApiMiddleware | undefined;
    readSession(): AuthSession | undefined;
    requireSession(): AuthSession;
    resolveRoomRef(room?: string | GroupRef): GroupRef | undefined;
    resolveTargetPeerIds(input?: RallarTargetSelector): readonly string[];
    createTargetedChannel<T>(
        definition: RallarTargetedChannelDefinition
    ): RallarTargetedChannel<T>;
    messages: RallarMessagesController['operations'];
    rtc: RallarRtcFacade;
    media: RallarMediaFacade;
    mediaController: RallarMediaPort;
    sendWsUnicast<T>(
        peerId: string,
        payload: T,
        typeId: string,
        route: Readonly<{
            topicId: string;
            contextId: string;
            resourceId?: string;
        }>
    ): Promise<RallarMessageSendResult>;
}>;

export type RallarCallsController = Readonly<{
    operations: CreateRallarCallsFacadeOptions;
}>;

export function createRallarCallsController(
    options: CreateRallarCallsControllerOptions
): RallarCallsController {
    const toSignalPayload = (
        kind: RallarCallSignalKind,
        callId: string,
        toPeerIds: readonly string[],
        input: Partial<RallarCallInviteInput>,
        reason?: string
    ): RallarCallSignalPayload => {
        const session = options.requireSession();
        return {
            kind,
            callId,
            fromPeerId: session.sessionId,
            toPeerIds: [...new Set(toPeerIds)],
            roomRef: input.roomRef ??
                (input.roomId ? options.resolveRoomRef(input.roomId) : undefined),
            membership: input.membership,
            data: {
                laneIds: input.data?.lanes
                    ? [...new Set(input.data.lanes)]
                    : []
            },
            media: {
                audio: input.media?.audio,
                video: input.media?.video,
                screen: options.mediaController.readSourceStatus('screen')
                    ?.state === 'open'
            },
            message: input.message,
            reason,
            occurredAtEpochMs: Date.now()
        };
    };

    const sendSignals = async (
        peerIds: readonly string[],
        payload: RallarCallSignalPayload
    ): Promise<readonly RallarCallSignalSend[]> => {
        const uniquePeerIds = [...new Set(peerIds)]
            .filter((peerId) => peerId !== options.requireSession().sessionId);
        return await Promise.all(
            uniquePeerIds.map(async (peerId) => ({
                peerId,
                result: await options.sendWsUnicast(
                    peerId,
                    payload,
                    toCallSignalTypeId(payload.kind),
                    {
                        topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                        contextId: payload.callId
                    }
                )
            }))
        );
    };

    const isSignalForCurrentSession = (
        payload: RallarCallSignalPayload
    ): boolean => {
        const sessionId = options.readSession()?.sessionId;
        if (!sessionId || payload.fromPeerId === sessionId) {
            return false;
        }
        return payload.toPeerIds.length === 0 ||
            payload.toPeerIds.includes(sessionId);
    };

    const toSignalEvent = (
        message: RallarMessage<RallarCallSignalPayload>
    ): RallarCallSignalEvent | undefined => {
        if (!isRallarCallSignalPayload(message.payload)) {
            return undefined;
        }
        const payload = message.payload;
        if (!isSignalForCurrentSession(payload)) {
            return undefined;
        }
        return {
            kind: payload.kind,
            callId: payload.callId,
            fromPeerId: payload.fromPeerId,
            toPeerIds: payload.toPeerIds,
            roomRef: payload.roomRef,
            membership: payload.membership,
            dataLaneIds: payload.data?.laneIds ?? [],
            media: payload.media ?? {},
            message: payload.message,
            reason: payload.reason,
            payload,
            raw: message
        };
    };

    let startCall!: (input: RallarCallStartInput) => Promise<RallarCallHandle>;

    const toIncomingInvite = (
        message: RallarMessage<RallarCallSignalPayload>
    ): RallarIncomingCallInvite | undefined => {
        const event = toSignalEvent(message);
        if (!event || event.kind !== 'invite') {
            return undefined;
        }
        return {
            ...event,
            kind: 'invite',
            accept: async (
                input: Partial<RallarCallStartInput> = {}
            ): Promise<RallarCallHandle> => {
                await sendSignals(
                    [event.fromPeerId],
                    toSignalPayload(
                        'accepted',
                        event.callId,
                        [event.fromPeerId],
                        {
                            ...input,
                            callId: event.callId,
                            peerId: event.fromPeerId,
                            data: input.data ??
                                (event.dataLaneIds.length > 0
                                    ? { lanes: event.dataLaneIds }
                                    : undefined),
                            roomRef: input.roomRef ?? event.roomRef,
                            membership: input.membership ?? event.membership
                        }
                    )
                );
                return await startCall({
                    ...input,
                    callId: event.callId,
                    peerId: event.fromPeerId,
                    data: input.data ??
                        (event.dataLaneIds.length > 0
                            ? { lanes: event.dataLaneIds }
                            : undefined)
                });
            },
            decline: async (reason?: string) =>
                await sendSignals(
                    [event.fromPeerId],
                    toSignalPayload(
                        'declined',
                        event.callId,
                        [event.fromPeerId],
                        {
                            peerId: event.fromPeerId,
                            callId: event.callId,
                            data: event.dataLaneIds.length > 0
                                ? { lanes: event.dataLaneIds }
                                : undefined,
                            roomRef: event.roomRef,
                            membership: event.membership
                        },
                        reason
                    )
                )
        };
    };

    const toParticipantStatus = (
        peerId: string,
        laneIds: readonly string[],
        ended: boolean
    ): RallarCallParticipantStatus => {
        const rtcStatus = options.rtc.status({
            laneId: laneIds[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID
        });
        const peer = rtcStatus.peers.find((candidate) => candidate.peerId === peerId);
        const lanes = laneIds.length === 0
            ? peer?.lanes ?? []
            : laneIds.map((laneId) =>
                peer?.lanes.find((lane) => lane.laneId === laneId) ??
                    toMissingRtcLaneStatus(peerId, laneId)
            );
        const readyLaneIds = lanes.filter((lane) => lane.isOpen)
            .map((lane) => lane.laneId);
        const failedLaneIds = lanes
            .filter((lane) => !lane.isOpen && !lane.isReconnectable)
            .map((lane) => lane.laneId);
        return {
            peerId,
            state: toCallParticipantState({
                ended,
                peer,
                laneCount: laneIds.length,
                readyLaneCount: readyLaneIds.length,
                failedLaneCount: failedLaneIds.length
            }),
            lanes,
            readyLaneIds,
            failedLaneIds,
            reason: toCallParticipantReason(peer, laneIds.length, failedLaneIds)
        };
    };

    const toStatus = (
        input: Readonly<{
            callId: string;
            laneIds: readonly string[];
            peerIds: readonly string[];
            startedAtEpochMs: number;
            endedAtEpochMs?: number;
            media: Readonly<{
                localStreamId?: string;
                audioEnabled?: boolean;
                videoEnabled?: boolean;
            }>;
        }>
    ): RallarCallStatus => {
        const participants = input.peerIds.map((peerId) =>
            toParticipantStatus(
                peerId,
                input.laneIds,
                input.endedAtEpochMs !== undefined
            )
        );
        return {
            callId: input.callId,
            state: toCallState(participants, input.endedAtEpochMs),
            peerIds: input.peerIds,
            laneIds: input.laneIds,
            participants,
            startedAtEpochMs: input.startedAtEpochMs,
            endedAtEpochMs: input.endedAtEpochMs,
            media: {
                ...input.media,
                sources: options.mediaController.readSourceStatuses()
            }
        };
    };

    startCall = async (input: RallarCallStartInput): Promise<RallarCallHandle> => {
        await options.connect();
        const callId = input.callId ?? crypto.randomUUID();
        const startedAtEpochMs = Date.now();
        const laneIds = resolveCallLaneIds(input);
        const fixedPeerIds = input.membership === 'live'
            ? undefined
            : options.resolveTargetPeerIds(input);
        const mediaState: {
            localStreamId?: string;
            audioEnabled?: boolean;
            videoEnabled?: boolean;
        } = {
            localStreamId: input.media?.stream?.id,
            audioEnabled: input.media?.audio,
            videoEnabled: input.media?.video
        };
        let endedAtEpochMs: number | undefined;

        const resolvePeerIds = (
            targetOptions: RallarTargetSelector = {}
        ): readonly string[] => {
            if (fixedPeerIds && !hasTargetSelectorOverride(targetOptions)) {
                return fixedPeerIds;
            }
            return options.resolveTargetPeerIds({ ...input, ...targetOptions });
        };
        const status = (): RallarCallStatus =>
            toStatus({
                callId,
                laneIds,
                peerIds: resolvePeerIds(),
                startedAtEpochMs,
                endedAtEpochMs,
                media: mediaState
            });
        const wait = async (
            waitOptions: RallarCallWaitOptions = {}
        ): Promise<RallarCallStatus> => {
            if (endedAtEpochMs !== undefined) {
                return status();
            }
            const ctx = await options.connect();
            const peerIds = resolvePeerIds();
            if (laneIds.length === 0) {
                for (const peerId of peerIds) {
                    ctx.middleware.webRtcConnectionService
                        .ensurePeerConnectionStarted(peerId);
                }
                return status();
            }
            await Promise.all(
                peerIds.flatMap((peerId) =>
                    laneIds.map((laneId) =>
                        options.rtc.waitForLane(peerId, laneId, {
                            ...waitOptions,
                            connect: true
                        })
                    )
                )
            );
            return status();
        };
        const handle: RallarCallHandle = {
            id: callId,
            status,
            wait,
            channel: <T>(
                definition: Partial<RallarTargetedChannelDefinition> = {}
            ) => {
                const membership = definition.membership ?? input.membership ??
                    'fixed';
                const target = membership === 'live' &&
                        (input.roomId !== undefined || input.roomRef !== undefined) &&
                        !hasTargetSelectorOverride(definition)
                    ? {
                        roomId: input.roomId,
                        roomRef: input.roomRef,
                        membership
                    }
                    : {
                        peerIds: resolvePeerIds(definition),
                        membership
                    };
                return options.createTargetedChannel<T>({
                    ...definition,
                    ...target,
                    laneId: definition.laneId ?? laneIds[0]
                });
            },
            setLocalStream: async (stream) => {
                await options.media.setLocalStream(stream);
                mediaState.localStreamId = stream.id;
            },
            setAudioEnabled: async (enabled) => {
                await options.media.setAudioEnabled(enabled);
                mediaState.audioEnabled = enabled;
            },
            setVideoEnabled: async (enabled) => {
                await options.media.setVideoEnabled(enabled);
                mediaState.videoEnabled = enabled;
            },
            stopLocal: async (kind) => {
                await options.media.stopLocal(kind);
                if (kind === 'audio' || kind === 'all') {
                    mediaState.audioEnabled = false;
                }
                if (kind === 'video' || kind === 'all') {
                    mediaState.videoEnabled = false;
                }
                if (kind === 'all') {
                    mediaState.localStreamId = undefined;
                }
            },
            sources: {
                microphone: options.media.microphone,
                camera: options.media.camera,
                screen: options.media.screen
            },
            end: async (
                endOptions: RallarCallEndOptions = {}
            ): Promise<RallarCallStatus> => {
                if (endedAtEpochMs === undefined) {
                    endedAtEpochMs = Date.now();
                }
                const ctx = options.readMiddleware();
                if (endOptions.disconnectPeers ?? false) {
                    for (const peerId of resolvePeerIds()) {
                        ctx?.middleware.webRtcConnectionService
                            .disconnectPeer(peerId);
                    }
                }
                if (endOptions.stopLocalMedia ?? true) {
                    await options.media.stopLocal('all');
                    mediaState.localStreamId = undefined;
                    mediaState.audioEnabled = false;
                    mediaState.videoEnabled = false;
                }
                return status();
            }
        };

        if (input.media?.stream) {
            await handle.setLocalStream(input.media.stream);
        }
        if (input.media?.audio !== undefined) {
            await handle.setAudioEnabled(input.media.audio);
        }
        if (input.media?.video !== undefined) {
            await handle.setVideoEnabled(input.media.video);
        }
        await wait({ timeoutMs: input.data?.openTimeoutMs });
        return handle;
    };

    const operations: CreateRallarCallsFacadeOptions = {
        start: startCall,
        invite: async (input: RallarCallInviteInput): Promise<RallarCallInviteResult> => {
            await options.connect();
            const callId = input.callId ?? crypto.randomUUID();
            const peerIds = options.resolveTargetPeerIds(input);
            const payload = toSignalPayload('invite', callId, peerIds, input);
            return {
                callId,
                peerIds,
                signals: await sendSignals(peerIds, payload)
            };
        },
        onSignal: (listener: RallarCallSignalListener): RallarUnsubscribe =>
            options.messages.ws.onMessage<RallarCallSignalPayload>(
                { topicId: RALLAR_CALL_SIGNAL_TOPIC_ID },
                async (message) => {
                    const event = toSignalEvent(message);
                    if (event) {
                        await listener(event);
                    }
                }
            ),
        onInvite: (listener: RallarCallInviteListener): RallarUnsubscribe =>
            options.messages.ws.onMessage<RallarCallSignalPayload>(
                {
                    topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                    typeId: RALLAR_CALL_INVITE_TYPE_ID
                },
                async (message) => {
                    const invite = toIncomingInvite(message);
                    if (invite) {
                        await listener(invite);
                    }
                }
            )
    };

    return { operations };
}

function resolveCallLaneIds(input: RallarCallStartInput): readonly string[] {
    if (!input.data) {
        return input.media ? [] : [DEFAULT_RTC_DATA_CHANNEL_LANE_ID];
    }
    const lanes = input.data.lanes?.length
        ? input.data.lanes
        : [DEFAULT_RTC_DATA_CHANNEL_LANE_ID];
    return [...new Set(lanes.filter((laneId) => laneId.length > 0))];
}

function hasTargetSelectorOverride(input: RallarTargetSelector): boolean {
    return input.peerId !== undefined || input.peerIds !== undefined ||
        input.roomId !== undefined || input.roomRef !== undefined ||
        input.membership !== undefined;
}

function toMissingRtcLaneStatus(
    peerId: string,
    laneId: string
): RallarRtcLaneStatus {
    return { peerId, laneId, isOpen: false, isReconnectable: false };
}

function toCallParticipantState(
    input: Readonly<{
        ended: boolean;
        peer?: RallarRtcPeerStatus;
        laneCount: number;
        readyLaneCount: number;
        failedLaneCount: number;
    }>
): RallarCallParticipantState {
    if (input.ended) {
        return 'ended';
    }
    if (!input.peer) {
        return 'idle';
    }
    if (input.laneCount === 0) {
        return input.peer.hasNoReconnectableLanes
            ? 'failed'
            : input.peer.isActive
            ? 'open'
            : 'connecting';
    }
    if (input.readyLaneCount === input.laneCount) {
        return 'open';
    }
    if (input.readyLaneCount > 0) {
        return 'partial';
    }
    if (input.failedLaneCount === input.laneCount) {
        return 'failed';
    }
    return input.peer.isActive ? 'connecting' : 'idle';
}

function toCallState(
    participants: readonly RallarCallParticipantStatus[],
    endedAtEpochMs?: number
): RallarCallState {
    if (endedAtEpochMs !== undefined) {
        return 'ended';
    }
    if (participants.length === 0) {
        return 'empty';
    }
    if (participants.every((participant) => participant.state === 'open')) {
        return 'open';
    }
    if (participants.some((participant) => participant.state === 'open' || participant.state === 'partial')) {
        return 'partial';
    }
    if (participants.every((participant) => participant.state === 'failed')) {
        return 'failed';
    }
    return 'connecting';
}

function toCallParticipantReason(
    peer: RallarRtcPeerStatus | undefined,
    laneCount: number,
    failedLaneIds: readonly string[]
): string | undefined {
    if (!peer) {
        return 'RTC peer has not been opened yet.';
    }
    if (failedLaneIds.length > 0) {
        return `RTC lanes failed or are unavailable: ${failedLaneIds.join(', ')}.`;
    }
    if (laneCount > 0 && peer.readyLaneIds.length === 0) {
        return 'RTC data lanes are not open yet.';
    }
    return undefined;
}

function toCallSignalTypeId(kind: RallarCallSignalKind): string {
    switch (kind) {
        case 'invite':
            return RALLAR_CALL_INVITE_TYPE_ID;
        case 'accepted':
            return RALLAR_CALL_ACCEPT_TYPE_ID;
        case 'declined':
            return RALLAR_CALL_DECLINE_TYPE_ID;
        case 'cancelled':
            return RALLAR_CALL_CANCEL_TYPE_ID;
    }
}

function isRallarCallSignalPayload(
    value: unknown
): value is RallarCallSignalPayload {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<RallarCallSignalPayload>;
    return (
        candidate.kind === 'invite' || candidate.kind === 'accepted' ||
        candidate.kind === 'declined' || candidate.kind === 'cancelled'
    ) && typeof candidate.callId === 'string' &&
        typeof candidate.fromPeerId === 'string' &&
        Array.isArray(candidate.toPeerIds) &&
        candidate.toPeerIds.every((peerId) => typeof peerId === 'string') &&
        typeof candidate.occurredAtEpochMs === 'number';
}
