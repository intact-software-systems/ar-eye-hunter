import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { createRallarAuthFacade } from '@shared-web/browser/rallar-auth-facade.ts';
import { createRallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import { createRallarConnectionFacade } from '@shared-web/browser/rallar-connection-facade.ts';
import { createRallarCrdtFacade } from '@shared-web/browser/rallar-crdt.ts';
import {
    createRallarDataFacade,
    type RallarDataFacade,
} from '@shared-web/browser/rallar-data.ts';
import { createRallarDirectorFacade } from '@shared-web/browser/rallar-director-facade.ts';
import type {
    RallarFacade,
    RallarTargetedChannelDefinition,
} from '@shared-web/browser/rallar-facade-contract.ts';
import { createRallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import { createRallarMessagesFacade } from '@shared-web/browser/rallar-messages-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { createRallarPeopleFacade } from '@shared-web/browser/rallar-people-facade.ts';
import { createRallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import { createRallarRoomsFacade } from '@shared-web/browser/rooms/rallar-rooms-facade.ts';
import { createRallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import { createRallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRallarCallsController } from '@shared-web/browser/rallar-runtime/calls.ts';
import type {
    RallarAuthRuntimePort,
    RallarConnectionRuntimePort,
    RallarStateRuntimePort,
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import { createRallarDirectorController } from '@shared-web/browser/rallar-runtime/director.ts';
import { createRallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { createRallarMediaController } from '@shared-web/browser/rallar-runtime/media.ts';
import { createRallarMessagesController } from '@shared-web/browser/rallar-runtime/messages.ts';
import { createRallarPeopleController } from '@shared-web/browser/rallar-runtime/people.ts';
import {
    createRallarRealtimeController,
    resolveActiveRoomPeerIds,
} from '@shared-web/browser/rallar-runtime/realtime.ts';
import { createRallarRoomsController } from '@shared-web/browser/rallar-runtime/rooms.ts';
import { createRallarRtcController } from '@shared-web/browser/rallar-runtime/rtc.ts';
import {
    createRallarSessionController,
    type RallarSessionController,
} from '@shared-web/browser/rallar-runtime/session.ts';
import { createRallarStartupController } from '@shared-web/browser/rallar-runtime/startup.ts';
import { createRallarStateEvents } from '@shared-web/browser/rallar-runtime/state-events.ts';
import { createRallarStateStore } from '@shared-web/browser/rallar-runtime/state-store.ts';
import { createRallarStatsController } from '@shared-web/browser/rallar-runtime/stats.ts';
import { createRallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import { createRallarWsController } from '@shared-web/browser/rallar-runtime/ws.ts';
import { createRallarStatsFacade } from '@shared-web/browser/rallar-stats-facade.ts';
import { readSession } from '@shared/api/auth.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES } from '@shared/api/rallar-validation.ts';

const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';
const DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS = 5_000;

export function createBrowserRallarFacade(): RallarFacade {
    const runtime = createRallarBrowserFacadeRuntimeContext();
    const connectionRuntime: RallarConnectionRuntimePort = {
        readConnectState: runtime.readConnectState,
        setConnectState: runtime.setConnectState,
        readMiddleware: runtime.readMiddleware,
        setMiddleware: runtime.setMiddleware,
        requireMiddleware: runtime.requireMiddleware,
        clearMiddleware: runtime.clearMiddleware,
        readConnectPromise: runtime.readConnectPromise,
        setConnectPromise: runtime.setConnectPromise,
        setDefaults: runtime.setDefaults,
        defaults: runtime.defaults,
        readDefaults: runtime.readDefaults,
        readDefaultScope: runtime.readDefaultScope,
        resolveOperationScope: runtime.resolveOperationScope,
        resolveOperationOptions: runtime.resolveOperationOptions,
    };
    const stateRuntime: RallarStateRuntimePort = {
        readStateCacheUnsubscribe: runtime.readStateCacheUnsubscribe,
        setStateCacheUnsubscribe: runtime.setStateCacheUnsubscribe,
        currentRoomId: runtime.currentRoomId,
        currentRoomRef: runtime.currentRoomRef,
        setCurrentRoom: runtime.setCurrentRoom,
        clearCurrentRoom: runtime.clearCurrentRoom,
        clearCurrentRoomIfMatches: runtime.clearCurrentRoomIfMatches,
        readDefaultScope: runtime.readDefaultScope,
        resolveOperationScope: runtime.resolveOperationScope,
    };
    const authRuntime: RallarAuthRuntimePort = {
        readAuthExpiryTimer: runtime.readAuthExpiryTimer,
        setAuthExpiryTimer: runtime.setAuthExpiryTimer,
        clearAuthExpiryTimer: runtime.clearAuthExpiryTimer,
        readAuthEndPromise: runtime.readAuthEndPromise,
        setAuthEndPromise: runtime.setAuthEndPromise,
        endedAuthSessionKeys: runtime.endedAuthSessionKeys,
    };
    const lifecycle = createRallarLifecycleCoordinator();
    let sessionController!: RallarSessionController;
    let startupController!: ReturnType<typeof createRallarStartupController>;
    let data!: RallarDataFacade;

    const stateStore = createRallarStateStore({
        runtime: stateRuntime,
        readSession,
    });
    const readDefaults = () => runtime.readDefaults();
    const resolveDefaultRoomRef = (): GroupRef | undefined => {
        const defaultRoom = readDefaults()?.room;
        if (!defaultRoom) {
            return undefined;
        }
        return defaultRoom.roomRef ??
            (defaultRoom.roomId
                ? stateStore.resolveGroupRefFromRoomId(defaultRoom.roomId)
                : undefined);
    };
    const resolveDefaultRoom = (): string | GroupRef | undefined =>
        resolveDefaultRoomRef() ?? readDefaults()?.room?.roomId;
    const resolveRoomPeerIds = (
        room: string | GroupRef,
    ): readonly string[] => resolveActiveRoomPeerIds(
        readSession(),
        stateStore.findGroupSnapshot(room),
    );

    const wsInbox = createRallarWsInbox({
        readMiddleware: () => sessionController.readMiddleware(),
    });
    const stateEvents = createRallarStateEvents({
        wsInbox,
        readDefaultScope: () => sessionController.readDefaultScope(),
        resolveOperationOptions: <T extends RallarOperationOptions>(options: T) =>
            sessionController.resolveOperationOptions(options),
        resolveOperationScope: (scope) =>
            sessionController.resolveOperationScope(scope),
        runAuthAwareOperation: async <T>(operation: () => Promise<T>) =>
            await sessionController.runAuthAwareOperation(operation),
    });
    const messagesController = createRallarMessagesController({
        wsInbox,
        connect: async () => await sessionController.connect(),
        readMiddleware: () => sessionController.readMiddleware(),
        requireSession: () => sessionController.requireSession(),
        resolveDefaultRoom,
        resolveCurrentRoomRef: () => stateStore.resolveCurrentRoomRef(),
        toRoomId: (room) => stateStore.toRoomId(room),
        resolveRoomRef: (room) => stateStore.resolveRoomRef(room),
        resolveRoomMinSnapshotVersion: (room, explicit) =>
            stateStore.resolveRoomMinSnapshotVersion(room, explicit),
        resolveRoomPeerIds,
        readMessageMaxPayloadBytes: () =>
            readDefaults()?.messages?.maxPayloadBytes ??
                RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES,
    });
    const messages = createRallarMessagesFacade(messagesController.operations);

    const wsController = createRallarWsController({
        readMiddleware: () => sessionController.readMiddleware(),
        readSession,
        readConnectState: () => runtime.readConnectState(),
    });
    const rtcController = createRallarRtcController({
        readMiddleware: () => sessionController.readMiddleware(),
        readSession,
        readWsStatus: () => wsController.facade.status(),
        resolveRoomPeerIds,
        resolveRoomRef: (room) => stateStore.resolveRoomRef(room),
        toRoomId: (room) => stateStore.toRoomId(room),
        resolveRtcWaitTimeoutMs: (timeoutMs) =>
            timeoutMs ?? readDefaults()?.rtc?.waitTimeoutMs,
        resolveRtcConnectOnWait: (connect) =>
            connect ?? readDefaults()?.rtc?.connectOnWait ?? false,
    });
    const rtc = createRallarRtcFacade(rtcController.operations);
    const realtimeController = createRallarRealtimeController({
        connect: async () => await sessionController.connect(),
        readMiddleware: () => sessionController.readMiddleware(),
        readSession,
        readDefaultRoom: resolveDefaultRoom,
        readCurrentRoomRef: () => stateStore.resolveCurrentRoomRef(),
        readCurrentRoomSnapshot: () => stateStore.roomState().currentRoom,
        findGroupSnapshot: (room) => stateStore.findGroupSnapshot(room),
        resolveRoomPeerIds,
        resolveLaneId: (laneId) => laneId ??
            readDefaults()?.realtime?.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID,
        resolveOpenTimeoutMs: (openTimeoutMs) => openTimeoutMs ??
            readDefaults()?.realtime?.openTimeoutMs ??
            DEFAULT_RALLAR_REALTIME_OPEN_TIMEOUT_MS,
        rtc,
    });
    const realtime = createRallarRealtimeFacade(realtimeController.operations);
    const mediaController = createRallarMediaController({
        connect: async () => await sessionController.connect(),
        readMiddleware: () => sessionController.readMiddleware(),
    });
    const media = createRallarMediaFacade(mediaController.operations);

    const roomsController = createRallarRoomsController({
        stateStore,
        stateEvents,
        messages,
        realtime,
        connect: async (options) => await sessionController.connect(options),
        requireSession: () => sessionController.requireSession(),
        resolveOperationOptions: <T extends RallarOperationOptions>(options: T) =>
            sessionController.resolveOperationOptions(options),
        resolveOperationScope: (scope) =>
            sessionController.resolveOperationScope(scope),
        resolveDefaultRoom,
        resolveDefaultRoomRef,
        runAuthAwareOperation: async <T>(operation: () => Promise<T>) =>
            await sessionController.runAuthAwareOperation(operation),
        acceptSnapshots: async (ctx, clients, groups, scope) =>
            await stateStore.acceptSnapshots(ctx, clients, groups, scope),
    });
    const rooms = createRallarRoomsFacade(roomsController.operations);
    const peopleController = createRallarPeopleController({
        stateStore,
        stateEvents,
        resolveOperationOptions: <T extends RallarOperationOptions>(options: T) =>
            sessionController.resolveOperationOptions(options),
        resolveOperationScope: (scope) =>
            sessionController.resolveOperationScope(scope),
        runAuthAwareOperation: async <T>(operation: () => Promise<T>) =>
            await sessionController.runAuthAwareOperation(operation),
        connect: async (options) => await sessionController.connect(options),
        acceptSnapshots: async (ctx, clients, groups, scope) =>
            await stateStore.acceptSnapshots(ctx, clients, groups, scope),
    });
    const people = createRallarPeopleFacade(peopleController.operations);
    const statsController = createRallarStatsController({
        resolveOperationOptions: <T extends RallarOperationOptions>(options: T) =>
            sessionController.resolveOperationOptions(options),
        resolveOperationScope: (scope) =>
            sessionController.resolveOperationScope(scope),
        requireSession: () => sessionController.requireSession(),
        runAuthAwareOperation: async <T>(operation: () => Promise<T>) =>
            await sessionController.runAuthAwareOperation(operation),
    });
    const stats = createRallarStatsFacade(statsController.operations);

    const callsController = createRallarCallsController({
        connect: async () => await sessionController.connect(),
        readMiddleware: () => sessionController.readMiddleware(),
        readSession,
        requireSession: () => sessionController.requireSession(),
        resolveRoomRef: (room) => stateStore.resolveRoomRef(room),
        resolveTargetPeerIds: (input) =>
            realtimeController.resolveTargetPeerIds(input),
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            realtimeController.createTargetedChannel<T>(definition),
        messages,
        rtc,
        media,
        mediaController,
        sendWsUnicast: async (peerId, payload, typeId, route) =>
            await messagesController.sendWsUnicast(
                peerId,
                payload,
                typeId,
                route,
            ),
    });
    const calls = createRallarCallsFacade(callsController.operations);
    const directorController = createRallarDirectorController({
        stateStore,
        rooms,
        messages,
        realtime,
        readSession,
        requireSession: () => sessionController.requireSession(),
        connect: async (options) => await sessionController.connect(options),
        resolveOperationOptions: <T extends RallarOperationOptions>(options: T) =>
            sessionController.resolveOperationOptions(options),
        resolveOperationScope: (scope) =>
            sessionController.resolveOperationScope(scope),
        resolveDefaultRoom,
        runAuthAwareOperation: async <T>(operation: () => Promise<T>) =>
            await sessionController.runAuthAwareOperation(operation),
        acceptSnapshots: async (ctx, groups, scope) =>
            await stateStore.acceptSnapshots(ctx, [], groups, scope),
        createTargetedChannel: <T>(definition: RallarTargetedChannelDefinition) =>
            realtimeController.createTargetedChannel<T>(definition),
        sendWsUnicast: async (peerId, payload, typeId, route) =>
            await messagesController.sendWsUnicast(
                peerId,
                payload,
                typeId,
                route,
            ),
    });
    const director = createRallarDirectorFacade(directorController.operations);
    stateStore.onAfterEmit(() => directorController.onStateChanged());

    lifecycle.register({
        id: 'director-relays',
        order: 10,
        detach: () => directorController.stopRelays(),
    });
    lifecycle.register({
        id: 'state-cache',
        order: 20,
        attach: () => stateStore.attachCache(),
        connected: () => stateStore.emit(),
        detach: () => stateStore.detachCache(),
        disconnected: () => stateStore.emit(),
    });
    lifecycle.register({
        id: 'rtc-message-inbox',
        order: 30,
        attach: (ctx) => messagesController.attachRtc(ctx),
        detach: (ctx) => messagesController.detachRtc(ctx),
    });
    lifecycle.register({
        id: 'ws-inbox',
        order: 40,
        attach: (ctx) => wsInbox.attach(ctx),
        detach: (ctx) => wsInbox.detach(ctx),
    });
    lifecycle.register({
        id: 'ws-status',
        order: 50,
        attach: (ctx) => wsController.attach(ctx),
        connected: () => wsController.connected(),
        detach: (ctx) => wsController.detach(ctx),
        disconnected: () => wsController.disconnected(),
    });
    lifecycle.register({
        id: 'realtime-peer-lifecycle',
        order: 60,
        attach: (ctx) => realtimeController.attachPeerLifecycle(ctx),
        detach: (ctx) => realtimeController.detachPeerLifecycle(ctx),
    });
    lifecycle.register({
        id: 'rtc-status',
        order: 70,
        attach: (ctx) => rtcController.attach(ctx),
        connected: () => rtcController.connected(),
        detach: (ctx) => rtcController.detach(ctx),
        disconnected: () => rtcController.disconnected(),
    });
    lifecycle.register({
        id: 'realtime-lanes',
        order: 80,
        attach: () => realtimeController.attachLaneCallbacks(),
        detach: (ctx) => realtimeController.detachLaneCallbacks(ctx),
    });
    lifecycle.register({
        id: 'media',
        order: 90,
        attach: () => mediaController.attachRemoteStreamCallback(),
        detach: (ctx) => mediaController.stopForDisconnect(ctx),
    });

    data = createRallarDataFacade({
        resolveScopeKey: (scope) =>
            sessionController.resolveDataScopeKey(String(scope)),
    });
    sessionController = createRallarSessionController({
        connectionRuntime,
        authRuntime,
        stateRuntime,
        lifecycle,
        start: async (options) => await startupController.start(options),
        emitState: () => stateStore.emit(),
        closeDataScopes: async (session) => {
            await Promise.all([
                data.closeScope(`session:${session.sessionId}`),
                data.closeScope(`principal:${session.clientId}`),
            ]);
        },
    });
    const connection = createRallarConnectionFacade(
        sessionController.connectionOperations,
    );
    const auth = createRallarAuthFacade(sessionController.authOperations);
    startupController = createRallarStartupController({
        connection,
        auth,
        rooms,
        people,
        waitForAuthEnd: () => sessionController.waitForAuthEnd(),
        resolveOperationOptions: <T extends RallarOperationOptions>(options: T) =>
            sessionController.resolveOperationOptions(options),
    });
    const crdt = createRallarCrdtFacade({
        data,
        readDefaults,
        readTransport: () => messagesController.toCrdtMessageTransport(),
    });

    const channels = {
        targeted: <T>(definition: RallarTargetedChannelDefinition) =>
            realtimeController.createTargetedChannel<T>(definition),
        room: <T>(
            definition: Omit<
                RallarTargetedChannelDefinition,
                'peerId' | 'peerIds'
            >,
        ) => realtimeController.createTargetedChannel<T>({
            ...definition,
            membership: definition.membership ?? 'live',
        }),
    };

    return {
        configure: (config) => connection.configure(config),
        setDefaults: (defaults) => connection.setDefaults(defaults),
        defaults: () => connection.defaults(),
        setup: async (input) => await startupController.setup(input),
        connect: async (options) => await connection.connect(options),
        start: async (options) => await startupController.start(options),
        disconnect: async () => await connection.disconnect(),
        status: () => connection.status(),
        isConnected: () => connection.isConnected(),
        session: () => connection.session(),
        subscriptions: () => connection.subscriptions(),
        flow: <K, V>(policies = {}) => connection.flow<K, V>(policies),
        data,
        crdt,
        auth,
        rooms,
        people,
        stats,
        director,
        messages,
        channels,
        rtc,
        calls,
        ws: wsController.facade,
        realtime,
        media,
        advanced: {
            middleware: (): ApiMiddleware => sessionController.requireMiddleware(),
        },
    };
}
