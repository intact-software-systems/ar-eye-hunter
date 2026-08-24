import {
    createRallarBrowserFacadeRuntimeContext,
    type RallarBrowserFacadeRuntimeContext,
    type RallarBrowserRuntimeDefaults
} from '@shared-web/browser/rallar-runtime-context.ts';
import type {
    RallarAuthRuntimePort,
    RallarConnectionRuntimePort,
    RallarLifecycleCoordinator,
    RallarStateEventsPort,
    RallarStatePort,
    RallarStateRuntimePort
} from '@shared-web/browser/rallar-runtime/contracts.ts';
import { createRallarLifecycleCoordinator } from '@shared-web/browser/rallar-runtime/lifecycle.ts';
import { resolveActiveRoomPeerIds } from '@shared-web/browser/rallar-runtime/realtime.ts';
import type { RallarSessionController } from '@shared-web/browser/rallar-runtime/session.ts';
import { createRallarStateEvents } from '@shared-web/browser/rallar-runtime/state-events.ts';
import {
    createRallarStateCacheReadPort,
    createRallarStateStore
} from '@shared-web/browser/rallar-runtime/state-store.ts';
import { createRallarWsInbox, type RallarWsInbox } from '@shared-web/browser/rallar-runtime/ws-inbox.ts';
import { createRoomEvents, type RallarRoomEventsPort } from '@shared-web/browser/rooms/room-events.ts';
import { createRoomStateStore, type RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import { readSession } from '@shared/api/auth.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export interface BrowserRuntimeFoundation {
    readonly runtime: RallarBrowserFacadeRuntimeContext;
    readonly connectionRuntime: RallarConnectionRuntimePort;
    readonly stateRuntime: RallarStateRuntimePort;
    readonly authRuntime: RallarAuthRuntimePort;
    readonly lifecycle: RallarLifecycleCoordinator;
}

export interface BrowserStateComposition {
    readonly stateStore: RallarStatePort;
    readonly roomStateStore: RallarRoomStateStorePort;
    readonly readDefaults: () => RallarBrowserRuntimeDefaults | undefined;
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
    readonly readSessionController: () => RallarSessionController;
}

export function createBrowserRuntimeFoundation(): BrowserRuntimeFoundation {
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
        resolveOperationOptions: runtime.resolveOperationOptions
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
        lifecycle: createRallarLifecycleCoordinator()
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
    const stateStore = createRallarStateStore({
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
        resolveRoomPeerIds: (room) => resolveActiveRoomPeerIds(readSession(), roomStateStore.findGroupSnapshot(room))
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
        readDefaultScope: () => input.readSessionController().readDefaultScope(),
        resolveOperationOptions: (options) => input.readSessionController().resolveOperationOptions(options),
        resolveOperationScope: (scope) => input.readSessionController().resolveOperationScope(scope),
        runAuthAwareOperation: async (operation) => await input.readSessionController().runAuthAwareOperation(operation)
    });
    const stateEvents = createRallarStateEvents({
        wsInbox,
        readDefaultScope: () => input.readSessionController().readDefaultScope(),
        resolveOperationOptions: (options) => input.readSessionController().resolveOperationOptions(options),
        resolveOperationScope: (scope) => input.readSessionController().resolveOperationScope(scope),
        runAuthAwareOperation: async (operation) => await input.readSessionController().runAuthAwareOperation(operation)
    });
    return { wsInbox, roomEvents, stateEvents };
}
