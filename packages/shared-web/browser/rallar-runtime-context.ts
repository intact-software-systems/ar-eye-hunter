import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupId } from '@shared/api/group-client-views.ts';
import type {
    ApplicationId,
    GroupRef,
    GroupSnapshot,
    WorkspaceId,
} from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';
import {
    type ApiMiddleware,
    clearMiddleware as clearGlobalMiddleware,
    getMiddleware as getGlobalMiddleware,
    isMiddlewareReady as isGlobalMiddlewareReady,
} from '@shared-web/browser/app-context.ts';
import type {
    RallarOperationOptions,
    RallarOperationRetryPredicate,
} from '@shared-web/browser/rallar-operation-options.ts';

export type RallarBrowserConnectStatus = 'idle' | 'connecting' | 'connected';

export type RallarBrowserRuntimeDefaults = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
    room?: Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }>;
    realtime?: Readonly<{
        laneId?: string;
        openTimeoutMs?: number;
    }>;
    rtc?: Readonly<{
        waitTimeoutMs?: number;
        connectOnWait?: boolean;
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
        maxPeerConnections?: number;
    }>;
    messages?: Readonly<{
        maxPayloadBytes?: number;
    }>;
    operations?: Readonly<{
        timeoutMs?: number;
        maxAttempts?: number;
        shouldRetry?: RallarOperationRetryPredicate;
    }>;
}>;

export type RallarBrowserFacadeRuntimeContextOptions = Readonly<{
    isMiddlewareReady?: () => boolean;
    getMiddleware?: () => ApiMiddleware;
    clearMiddleware?: () => void;
}>;

export type RallarBrowserFacadeRuntimeContext = Readonly<{
    readConnectState(): RallarBrowserConnectStatus;
    setConnectState(state: RallarBrowserConnectStatus): void;
    cachedMiddleware(): ApiMiddleware | undefined;
    readMiddleware(): ApiMiddleware | undefined;
    setMiddleware(ctx: ApiMiddleware | undefined): void;
    requireMiddleware(): ApiMiddleware;
    clearMiddleware(): void;
    readConnectPromise(): Promise<ApiMiddleware> | undefined;
    setConnectPromise(promise: Promise<ApiMiddleware> | undefined): void;
    readStateCacheUnsubscribe(): (() => void) | undefined;
    setStateCacheUnsubscribe(unsubscribe: (() => void) | undefined): void;
    currentRoomId(): string | undefined;
    currentRoomRef(): GroupRef | undefined;
    setCurrentRoom(snapshot: GroupSnapshot): void;
    clearCurrentRoom(): void;
    clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
    setDefaults(defaults?: RallarBrowserRuntimeDefaults): void;
    defaults(): RallarBrowserRuntimeDefaults | undefined;
    readDefaults(): RallarBrowserRuntimeDefaults | undefined;
    readDefaultScope(): StateScope | undefined;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions;
    readAuthExpiryTimer(): ReturnType<typeof setTimeout> | undefined;
    setAuthExpiryTimer(timer: ReturnType<typeof setTimeout> | undefined): void;
    clearAuthExpiryTimer(): void;
    readAuthEndPromise(): Promise<void> | undefined;
    setAuthEndPromise(promise: Promise<void> | undefined): void;
    endedAuthSessionKeys(): Set<string>;
}>;

type RallarBrowserFacadeRuntimeState = {
    connectState: RallarBrowserConnectStatus;
    middleware?: ApiMiddleware;
    connectPromise?: Promise<ApiMiddleware>;
    stateCacheUnsubscribe?: () => void;
    currentRoomId?: string;
    currentRoomRef?: GroupRef;
    defaults?: RallarBrowserRuntimeDefaults;
    defaultScope?: StateScope;
    authExpiryTimer?: ReturnType<typeof setTimeout>;
    authEndPromise?: Promise<void>;
    endedAuthSessionKeys: Set<string>;
};

export function createRallarBrowserFacadeRuntimeContext(
    options: RallarBrowserFacadeRuntimeContextOptions = {},
): RallarBrowserFacadeRuntimeContext {
    const isMiddlewareReady = options.isMiddlewareReady ?? isGlobalMiddlewareReady;
    const getMiddleware = options.getMiddleware ?? getGlobalMiddleware;
    const clearMiddleware = options.clearMiddleware ?? clearGlobalMiddleware;
    const state: RallarBrowserFacadeRuntimeState = {
        connectState: 'idle',
        endedAuthSessionKeys: new Set<string>(),
    };

    return {
        readConnectState: () => state.connectState,
        setConnectState: (connectState): void => {
            state.connectState = connectState;
        },
        cachedMiddleware: () => state.middleware,
        readMiddleware: (): ApiMiddleware | undefined => {
            if (state.middleware) {
                return state.middleware;
            }

            if (!isMiddlewareReady()) {
                return undefined;
            }

            state.middleware = getMiddleware();
            return state.middleware;
        },
        setMiddleware: (ctx): void => {
            state.middleware = ctx;
        },
        requireMiddleware: (): ApiMiddleware => {
            const ctx = state.middleware ?? (
                isMiddlewareReady() ? getMiddleware() : undefined
            );
            if (!ctx) {
                throw new Error('Rallar is not connected. Call rallar.connect() first.');
            }

            state.middleware = ctx;
            return ctx;
        },
        clearMiddleware: (): void => {
            state.middleware = undefined;
            clearMiddleware();
        },
        readConnectPromise: () => state.connectPromise,
        setConnectPromise: (promise): void => {
            state.connectPromise = promise;
        },
        readStateCacheUnsubscribe: () => state.stateCacheUnsubscribe,
        setStateCacheUnsubscribe: (unsubscribe): void => {
            state.stateCacheUnsubscribe = unsubscribe;
        },
        currentRoomId: () => state.currentRoomId,
        currentRoomRef: () => state.currentRoomRef,
        setCurrentRoom: (snapshot): void => {
            state.currentRoomId = readGroupId(snapshot);
            state.currentRoomRef = snapshot.group;
        },
        clearCurrentRoom: (): void => {
            state.currentRoomId = undefined;
            state.currentRoomRef = undefined;
        },
        clearCurrentRoomIfMatches: (room, clearCurrent): void => {
            if (!clearCurrent) {
                return;
            }

            if (
                typeof room === 'string'
                    ? state.currentRoomId === room
                    : state.currentRoomRef
                        ? isSameGroupRef(state.currentRoomRef, room)
                        : state.currentRoomId === room.groupId
            ) {
                state.currentRoomId = undefined;
                state.currentRoomRef = undefined;
            }
        },
        setDefaults: (defaults): void => {
            state.defaults = defaults ? cloneRallarRuntimeDefaults(defaults) : undefined;
            state.defaultScope = defaults
                ? {
                    applicationId: defaults.applicationId,
                    workspaceId: defaults.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
                }
                : undefined;
        },
        defaults: () =>
            state.defaults ? cloneRallarRuntimeDefaults(state.defaults) : undefined,
        readDefaults: () => state.defaults,
        readDefaultScope: () => state.defaultScope,
        resolveOperationScope: (scope) => scope ?? state.defaultScope,
        resolveOperationOptions: <T extends RallarOperationOptions>(
            options: T,
        ): T & RallarOperationOptions => {
            const timeoutMs = options.timeoutMs !== undefined
                ? options.timeoutMs
                : state.defaults?.operations?.timeoutMs;
            const maxAttempts = options.maxAttempts !== undefined
                ? options.maxAttempts
                : state.defaults?.operations?.maxAttempts;
            const shouldRetry = options.shouldRetry ??
                state.defaults?.operations?.shouldRetry;
            const dataChannelLanes = options.dataChannelLanes !== undefined
                ? options.dataChannelLanes
                : state.defaults?.rtc?.dataChannelLanes;
            const maxPeerConnections = options.maxPeerConnections !== undefined
                ? options.maxPeerConnections
                : state.defaults?.rtc?.maxPeerConnections;

            if (
                timeoutMs === undefined &&
                maxAttempts === undefined &&
                shouldRetry === undefined &&
                dataChannelLanes === undefined &&
                maxPeerConnections === undefined
            ) {
                return options;
            }

            return {
                ...options,
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(maxAttempts !== undefined ? { maxAttempts } : {}),
                ...(shouldRetry !== undefined ? { shouldRetry } : {}),
                ...(dataChannelLanes !== undefined ? { dataChannelLanes } : {}),
                ...(maxPeerConnections !== undefined ? { maxPeerConnections } : {}),
            };
        },
        readAuthExpiryTimer: () => state.authExpiryTimer,
        setAuthExpiryTimer: (timer): void => {
            state.authExpiryTimer = timer;
        },
        clearAuthExpiryTimer: (): void => {
            if (state.authExpiryTimer !== undefined) {
                clearTimeout(state.authExpiryTimer);
                state.authExpiryTimer = undefined;
            }
        },
        readAuthEndPromise: () => state.authEndPromise,
        setAuthEndPromise: (promise): void => {
            state.authEndPromise = promise;
        },
        endedAuthSessionKeys: () => state.endedAuthSessionKeys,
    };
}

export function cloneRallarRuntimeDefaults(
    defaults: RallarBrowserRuntimeDefaults,
): RallarBrowserRuntimeDefaults {
    return {
        applicationId: defaults.applicationId,
        ...(defaults.workspaceId !== undefined
            ? { workspaceId: defaults.workspaceId }
            : {}),
        ...(defaults.room
            ? {
                room: {
                    ...(defaults.room.roomId !== undefined
                        ? { roomId: defaults.room.roomId }
                        : {}),
                    ...(defaults.room.roomRef
                        ? { roomRef: { ...defaults.room.roomRef } }
                        : {}),
                },
            }
            : {}),
        ...(defaults.realtime
            ? { realtime: { ...defaults.realtime } }
            : {}),
        ...(defaults.rtc
            ? {
                rtc: {
                    ...defaults.rtc,
                    ...(defaults.rtc.dataChannelLanes
                        ? { dataChannelLanes: [...defaults.rtc.dataChannelLanes] }
                        : {}),
                },
            }
            : {}),
        ...(defaults.messages
            ? { messages: { ...defaults.messages } }
            : {}),
        ...(defaults.operations
            ? { operations: { ...defaults.operations } }
            : {}),
    };
}
