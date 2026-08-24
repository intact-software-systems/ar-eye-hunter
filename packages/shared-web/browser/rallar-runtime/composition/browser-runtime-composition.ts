import {
    browserTransportRuntime,
    type BrowserTransportRuntimePort
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    BrowserFacadeRuntimeState,
    type RallarAuthRuntimePort,
    type RallarBrowserFacadeRuntimeContext,
    type RallarConnectionRuntimePort,
    type RallarStateRuntimePort
} from '@shared-web/browser/rallar-runtime-context.ts';
import {
    createRallarLifecycleCoordinator,
    type RallarLifecycleCoordinator
} from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import {
    createRallarStateEvents,
    type RallarStateEventsPort
} from '@shared-web/browser/rallar-runtime/state-events.ts';
import {
    createRallarStateCacheReadPort,
    RallarStateStore,
    type RallarStatePort
} from '@shared-web/browser/rallar-runtime/state-store.ts';
import { createRallarWsInbox, type RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import { createRoomEvents, type RallarRoomEventsPort } from '@shared-web/browser/rooms/room-events.ts';
import { resolveActiveRoomPeerIds } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import { createRoomStateStore, type RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import { readSession } from '@shared/api/auth.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export interface BrowserRuntimeFoundation {
    readonly runtime: RallarBrowserFacadeRuntimeContext;
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly stateRuntime: RallarStateRuntimePort;
    readonly authRuntime: RallarAuthRuntimePort;
    readonly lifecycle: RallarLifecycleCoordinator;
    readonly transportRuntime: BrowserTransportRuntimePort;
}

export interface BrowserStateComposition {
    readonly stateStore: RallarStatePort;
    readonly roomStateStore: RallarRoomStateStorePort;
    readonly readDefaults: () => RallarDefaults | undefined;
    readonly resolveDefaultRoomRef: () => GroupRef | undefined;
    readonly resolveDefaultRoom: () => string | GroupRef | undefined;
    readonly resolveRoomPeerIds: (room: string | GroupRef) => readonly string[];
}

export interface BrowserStateEventComposition {
    readonly wsInbox: RallarWsInbox;
    readonly roomEvents: RallarRoomEventsPort;
    readonly stateEvents: RallarStateEventsPort;
}

export interface CreateBrowserStateCompositionInput {
    readonly runtime: RallarBrowserFacadeRuntimeContext;
    readonly stateRuntime: RallarStateRuntimePort;
}

export interface CreateBrowserStateEventCompositionInput {
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly session: RallarSessionController;
}

export function createBrowserRuntimeFoundation(): BrowserRuntimeFoundation {
    const transportRuntime = browserTransportRuntime;
    const runtime = new BrowserFacadeRuntimeState(transportRuntime);
    const connectionRuntime: RallarConnectionRuntimePort = {
        readConnectState: runtime.readConnectState,
        setConnectState: runtime.setConnectState,
        readMiddleware: runtime.readMiddleware,
        requireMiddleware: runtime.requireMiddleware,
        setDefaults: runtime.setDefaults,
        defaults: runtime.defaults,
        readDefaults: runtime.readDefaults,
        readDefaultScope: runtime.readDefaultScope,
        resolveOperationScope: runtime.resolveOperationScope,
        resolveOperationOptions: runtime.resolveOperationOptions
    };
    const stateRuntime: RallarStateRuntimePort = {
        readStateCacheUnsubscribe: runtime.readStateCacheUnsubscribe,
        setStateCacheUnsubscribe: runtime.setStateCacheUnsubscribe,
        currentRoomRef: runtime.currentRoomRef,
        setCurrentRoom: runtime.setCurrentRoom,
        clearCurrentRoomIfMatches: runtime.clearCurrentRoomIfMatches,
        readDefaultScope: runtime.readDefaultScope,
        resolveOperationScope: runtime.resolveOperationScope
    };
    const authRuntime: RallarAuthRuntimePort = {
        readAuthExpiryTimer: runtime.readAuthExpiryTimer,
        setAuthExpiryTimer: runtime.setAuthExpiryTimer,
        clearAuthExpiryTimer: runtime.clearAuthExpiryTimer,
        readAuthEndPromise: runtime.readAuthEndPromise,
        setAuthEndPromise: runtime.setAuthEndPromise,
        endedAuthSessionKeys: runtime.endedAuthSessionKeys
    };
    return {
        runtime,
        connectionRuntime,
        stateRuntime,
        authRuntime,
        lifecycle: createRallarLifecycleCoordinator(),
        transportRuntime
    };
}

export function createBrowserStateComposition(
    input: CreateBrowserStateCompositionInput
): BrowserStateComposition {
    const stateCache = createRallarStateCacheReadPort();
    const roomStateStore = createRoomStateStore({
        runtime: input.stateRuntime,
        readSession,
        stateCache
    });
    const stateStore = new RallarStateStore({
        runtime: input.stateRuntime,
        roomStateStore,
        readSession,
        stateCache
    });
    const readDefaults = input.runtime.readDefaults;
    const resolveDefaultRoomRef = (): GroupRef | undefined => {
        const defaultRoom = readDefaults()?.room;
        if (!defaultRoom) {
            return undefined;
        }
        return (
            defaultRoom.roomRef ??
                (defaultRoom.roomId
                    ? roomStateStore.resolveGroupRefFromRoomId(defaultRoom.roomId)
                    : undefined)
        );
    };
    const resolveDefaultRoom = (): string | GroupRef | undefined =>
        resolveDefaultRoomRef() ?? readDefaults()?.room?.roomId;
    return {
        stateStore,
        roomStateStore,
        readDefaults,
        resolveDefaultRoomRef,
        resolveDefaultRoom,
        resolveRoomPeerIds: (room) =>
            resolveActiveRoomPeerIds(readSession()?.sessionId, roomStateStore.findGroupSnapshot(room))
    };
}

export function createBrowserStateEventComposition(
    input: CreateBrowserStateEventCompositionInput
): BrowserStateEventComposition {
    const wsInbox = createRallarWsInbox({
        readMiddleware: input.connectionRuntime.readMiddleware
    });
    const roomEvents = createRoomEvents({
        wsInbox,
        readDefaultScope: input.session.readDefaultScope,
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        runAuthAwareOperation: input.session.runAuthAwareOperation
    });
    const stateEvents = createRallarStateEvents({
        wsInbox,
        readDefaultScope: input.session.readDefaultScope,
        resolveOperationOptions: input.session.resolveOperationOptions,
        resolveOperationScope: input.session.resolveOperationScope,
        runAuthAwareOperation: input.session.runAuthAwareOperation
    });
    return { wsInbox, roomEvents, stateEvents };
}
