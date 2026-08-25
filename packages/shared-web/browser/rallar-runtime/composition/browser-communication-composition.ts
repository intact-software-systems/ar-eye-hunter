import {
    BrowserLocalMediaSourceRuntime
} from '@shared-web/browser/media/browser-local-media-source-runtime.ts';
import {
    BrowserRemoteMediaStreamRuntime
} from '@shared-web/browser/media/browser-remote-media-stream-runtime.ts';
import {
    BrowserRallarMessagesController
} from '@shared-web/browser/messages/browser-rallar-messages-controller.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { BrowserRealtimeReceiveRuntime } from '@shared-web/browser/realtime/browser-realtime-receive-runtime.ts';
import { BrowserRealtimeHealthRuntime } from '@shared-web/browser/realtime/browser-realtime-health-runtime.ts';
import { BrowserRealtimeSendRuntime } from '@shared-web/browser/realtime/browser-realtime-send-runtime.ts';
import { BrowserRoomRealtimeRuntime } from '@shared-web/browser/realtime/browser-room-realtime-runtime.ts';
import { BrowserTargetedRealtimeRuntime } from '@shared-web/browser/realtime/browser-targeted-realtime-runtime.ts';
import { BrowserRallarRtcController } from '@shared-web/browser/rtc/browser-rallar-rtc-controller.ts';
import {
    BrowserRallarWsController,
    type RallarWsController
} from '@shared-web/browser/websocket/browser-rallar-ws-controller.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import { readSession } from '@shared/api/auth.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES } from '@shared/api/rallar-validation.ts';
import type { RallarBrowserFacadeRuntimeContext } from '../../rallar-runtime-context.ts';

import type { BrowserStateComposition } from './browser-runtime-composition.ts';

const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';
const DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS = 5_000;

export interface BrowserMessagingComposition {
    readonly messagesController: BrowserRallarMessagesController;
    readonly messages: RallarMessagesOperations;
}

export interface BrowserRealtimeCoreComposition {
    readonly wsController: RallarWsController;
    readonly rtcController: BrowserRallarRtcController;
    readonly rtc: RallarRtcFacade;
    readonly realtimeReceive: BrowserRealtimeReceiveRuntime;
    readonly realtimeTargeted: BrowserTargetedRealtimeRuntime;
    readonly realtime: RallarRealtimeFacade;
}

export interface BrowserMediaComposition {
    readonly localMediaSources: BrowserLocalMediaSourceRuntime;
    readonly remoteMediaStreams: BrowserRemoteMediaStreamRuntime;
    readonly media: RallarMediaFacade;
}

export interface CreateBrowserMessagingCompositionInput {
    readonly wsInbox: BrowserWebSocketInbox;
    readonly state: BrowserStateComposition;
    readonly session: RallarSessionController;
}

export interface CreateBrowserRealtimeCoreCompositionInput {
    readonly runtime: RallarBrowserFacadeRuntimeContext;
    readonly state: BrowserStateComposition;
    readonly session: RallarSessionController;
}

export interface CreateBrowserMediaCompositionInput {
    readonly session: RallarSessionController;
}

export function createBrowserMessagingComposition(
    input: CreateBrowserMessagingCompositionInput
): BrowserMessagingComposition {
    const messagesController = new BrowserRallarMessagesController({
        wsInbox: input.wsInbox,
        connect: async () => await input.session.connect(),
        readMiddleware: input.session.readMiddleware,
        requireSession: input.session.requireSession,
        resolveDefaultRoom: input.state.resolveDefaultRoom,
        resolveCurrentRoomRef: () => input.state.roomStateStore.resolveCurrentRoomRef(),
        toRoomId: (room) => input.state.roomStateStore.toRoomId(room),
        resolveRoomRef: (room) => input.state.roomStateStore.resolveRoomRef(room),
        resolveRoomMinSnapshotVersion: (room, explicit) =>
            input.state.roomStateStore.resolveRoomMinSnapshotVersion(room, explicit),
        resolveRoomPeerIds: input.state.resolveRoomPeerIds,
        readMessageMaxPayloadBytes: () =>
            input.state.readDefaults()?.messages?.maxPayloadBytes ??
                RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES
    });
    return {
        messagesController,
        messages: messagesController.operations
    };
}

export function createBrowserRealtimeCoreComposition(
    input: CreateBrowserRealtimeCoreCompositionInput
): BrowserRealtimeCoreComposition {
    const rtcComposition = createBrowserRtcComposition(input);
    const realtimeComposition = createBrowserRealtimeChannelComposition({
        ...input,
        rtc: rtcComposition.rtc
    });
    return {
        ...rtcComposition,
        ...realtimeComposition
    };
}

export function createBrowserMediaComposition(
    input: CreateBrowserMediaCompositionInput
): BrowserMediaComposition {
    const localMediaSources = new BrowserLocalMediaSourceRuntime({
        connect: async () => await input.session.connect()
    });
    const remoteMediaStreams = new BrowserRemoteMediaStreamRuntime({
        readMiddleware: input.session.readMiddleware
    });
    const media: RallarMediaFacade = {
        microphone: localMediaSources.createController('microphone'),
        camera: localMediaSources.createController('camera'),
        screen: localMediaSources.createController('screen'),
        setLocalStream: async (stream) => await localMediaSources.setLocalStream(stream),
        setAudioEnabled: async (enabled) => await localMediaSources.setAudioEnabled(enabled),
        setVideoEnabled: async (enabled) => await localMediaSources.setVideoEnabled(enabled),
        stopLocal: async (kind) => await localMediaSources.stopLocal(kind),
        setPolicy: async (policy) => {
            const context = await input.session.connect();
            context.middleware.rtcRxStreamer.setMediaPolicy(policy);
        },
        onRemoteStream: (listener) => remoteMediaStreams.onRemoteStream(listener)
    };
    return {
        localMediaSources,
        remoteMediaStreams,
        media
    };
}

interface BrowserRtcComposition {
    readonly wsController: RallarWsController;
    readonly rtcController: BrowserRallarRtcController;
    readonly rtc: RallarRtcFacade;
}

function createBrowserRtcComposition(
    input: CreateBrowserRealtimeCoreCompositionInput
): BrowserRtcComposition {
    const wsController = new BrowserRallarWsController({
        readMiddleware: input.session.readMiddleware,
        readSession,
        readConnectState: () => input.runtime.readConnectState()
    });
    const rtcController = new BrowserRallarRtcController({
        readMiddleware: input.session.readMiddleware,
        readSession,
        readWsStatus: () => wsController.facade.status(),
        resolveRoomPeerIds: input.state.resolveRoomPeerIds,
        resolveRoomRef: (room) => input.state.roomStateStore.resolveRoomRef(room),
        toRoomId: (room) => input.state.roomStateStore.toRoomId(room),
        resolveRtcWaitTimeoutMs: (timeoutMs) => timeoutMs ?? input.state.readDefaults()?.rtc?.waitTimeoutMs,
        resolveRtcConnectOnWait: (connect) => connect ?? input.state.readDefaults()?.rtc?.connectOnWait ?? false
    });
    return { wsController, rtcController, rtc: rtcController.operations };
}

interface BrowserRealtimeChannelComposition {
    readonly realtimeReceive: BrowserRealtimeReceiveRuntime;
    readonly realtimeTargeted: BrowserTargetedRealtimeRuntime;
    readonly realtime: RallarRealtimeFacade;
}

interface CreateBrowserRealtimeChannelCompositionInput extends CreateBrowserRealtimeCoreCompositionInput {
    readonly rtc: RallarRtcFacade;
}

function createBrowserRealtimeChannelComposition(
    input: CreateBrowserRealtimeChannelCompositionInput
): BrowserRealtimeChannelComposition {
    const ownerInput = {
        connect: async () => await input.session.connect(),
        readMiddleware: input.session.readMiddleware,
        readSession,
        readDefaultRoom: input.state.resolveDefaultRoom,
        readCurrentRoomRef: () => input.state.roomStateStore.resolveCurrentRoomRef(),
        readCurrentRoomSnapshot: () => input.state.roomStateStore.state().currentRoom,
        findGroupSnapshot: (room: string | GroupRef) => input.state.roomStateStore.findGroupSnapshot(room),
        resolveRoomPeerIds: input.state.resolveRoomPeerIds,
        resolveLaneId: (laneId?: string) =>
            laneId ?? input.state.readDefaults()?.realtime?.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID,
        resolveOpenTimeoutMs: (openTimeoutMs?: number) =>
            openTimeoutMs ??
                input.state.readDefaults()?.realtime?.openTimeoutMs ??
                DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS,
        rtc: input.rtc
    };
    const realtimeReceive = new BrowserRealtimeReceiveRuntime(ownerInput);
    const realtimeHealth = new BrowserRealtimeHealthRuntime({
        readMiddleware: input.session.readMiddleware
    });
    const realtimeSend = new BrowserRealtimeSendRuntime({
        ...ownerInput,
        onJson: (laneId, handler) => realtimeReceive.onJson(laneId, handler)
    });
    const realtimeRoom = new BrowserRoomRealtimeRuntime({
        ...ownerInput,
        sendJson: async (sendInput) => await realtimeSend.sendJson(sendInput),
        onJson: (laneId, handler) => realtimeReceive.onJson(laneId, handler)
    });
    const realtimeTargeted = new BrowserTargetedRealtimeRuntime({
        ...ownerInput,
        sendJson: async (sendInput) => await realtimeSend.sendJson(sendInput),
        onJson: (laneId, handler) => realtimeReceive.onJson(laneId, handler)
    });
    const realtime: RallarRealtimeFacade = {
        sendJson: async (sendInput) => await realtimeSend.sendJson(sendInput),
        sendBinary: async (sendInput) => await realtimeSend.sendBinary(sendInput),
        onJson: (laneId, handler) => realtimeReceive.onJson(laneId, handler),
        onBinary: (laneId, handler) => realtimeReceive.onBinary(laneId, handler),
        json: (defaults = {}) => realtimeSend.createJsonLane(defaults),
        room: (defaults = {}) => realtimeRoom.create(defaults),
        health: (options = {}) => realtimeHealth.read(options)
    };
    return {
        realtimeReceive,
        realtimeTargeted,
        realtime
    };
}
