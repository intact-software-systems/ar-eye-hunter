import type {
    ApiMiddleware,
    BrowserTransportRuntimePort
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupId } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';

export type RallarBrowserConnectStatus = 'idle' | 'connecting' | 'connected';

export type RallarBrowserFacadeRuntimeContextOptions = Readonly<{
    transportRuntime: BrowserTransportRuntimePort;
}>;

export type RallarBrowserFacadeRuntimeContext = Readonly<{
    readConnectState(): RallarBrowserConnectStatus;
    setConnectState(state: RallarBrowserConnectStatus): void;
    readMiddleware(): ApiMiddleware | undefined;
    requireMiddleware(): ApiMiddleware;
    readStateCacheUnsubscribe(): (() => void) | undefined;
    setStateCacheUnsubscribe(unsubscribe: (() => void) | undefined): void;
    currentRoomId(): string | undefined;
    currentRoomRef(): GroupRef | undefined;
    setCurrentRoom(snapshot: GroupSnapshot): void;
    clearCurrentRoom(): void;
    clearCurrentRoomIfMatches(room: string | GroupRef, clearCurrent: boolean): void;
    setDefaults(defaults?: RallarDefaults): void;
    defaults(): RallarDefaults | undefined;
    readDefaults(): RallarDefaults | undefined;
    readDefaultScope(): StateScope | undefined;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    readAuthExpiryTimer(): ReturnType<typeof setTimeout> | undefined;
    setAuthExpiryTimer(timer: ReturnType<typeof setTimeout> | undefined): void;
    clearAuthExpiryTimer(): void;
    readAuthEndPromise(): Promise<void> | undefined;
    setAuthEndPromise(promise: Promise<void> | undefined): void;
    endedAuthSessionKeys(): Set<string>;
}>;

export type RallarConnectionRuntimePort = Pick<
    RallarBrowserFacadeRuntimeContext,
    | 'readConnectState'
    | 'setConnectState'
    | 'readMiddleware'
    | 'requireMiddleware'
    | 'setDefaults'
    | 'defaults'
    | 'readDefaults'
    | 'readDefaultScope'
    | 'resolveOperationScope'
    | 'resolveOperationOptions'
>;

export type RallarStateRuntimePort = Pick<
    RallarBrowserFacadeRuntimeContext,
    | 'readStateCacheUnsubscribe'
    | 'setStateCacheUnsubscribe'
    | 'currentRoomRef'
    | 'setCurrentRoom'
    | 'clearCurrentRoomIfMatches'
    | 'readDefaultScope'
    | 'resolveOperationScope'
>;

export type RallarAuthRuntimePort = Pick<
    RallarBrowserFacadeRuntimeContext,
    | 'readAuthExpiryTimer'
    | 'setAuthExpiryTimer'
    | 'clearAuthExpiryTimer'
    | 'readAuthEndPromise'
    | 'setAuthEndPromise'
    | 'endedAuthSessionKeys'
>;

type RallarBrowserFacadeRuntimeState = {
    connectState: RallarBrowserConnectStatus;
    stateCacheUnsubscribe?: () => void;
    currentRoomId?: string;
    currentRoomRef?: GroupRef;
    defaults?: RallarDefaults;
    defaultScope?: StateScope;
    authExpiryTimer?: ReturnType<typeof setTimeout>;
    authEndPromise?: Promise<void>;
    endedAuthSessionKeys: Set<string>;
};

export function createRallarBrowserFacadeRuntimeContext(
    options: RallarBrowserFacadeRuntimeContextOptions
): RallarBrowserFacadeRuntimeContext {
    const transportRuntime = options.transportRuntime;
    const state: RallarBrowserFacadeRuntimeState = {
        connectState: 'idle',
        endedAuthSessionKeys: new Set<string>()
    };

    return {
        readConnectState: () => state.connectState,
        setConnectState: (connectState): void => {
            state.connectState = connectState;
        },
        readMiddleware: () => transportRuntime.readMiddleware(),
        requireMiddleware: () => transportRuntime.requireMiddleware(),
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
                    workspaceId: defaults.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID
                }
                : undefined;
        },
        defaults: () => state.defaults ? cloneRallarRuntimeDefaults(state.defaults) : undefined,
        readDefaults: () => state.defaults,
        readDefaultScope: () => state.defaultScope,
        resolveOperationScope: (scope) => scope ?? state.defaultScope,
        resolveOperationOptions: <T extends RallarOperationOptions>(
            options: T
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
            const rttReportingDegreeLimit = options.rttReportingDegreeLimit !== undefined
                ? options.rttReportingDegreeLimit
                : state.defaults?.rtc?.rttReportingDegreeLimit;
            const bootstrapDegree = options.bootstrapDegree !== undefined
                ? options.bootstrapDegree
                : state.defaults?.rtc?.bootstrapDegree;

            if (
                timeoutMs === undefined &&
                maxAttempts === undefined &&
                shouldRetry === undefined &&
                dataChannelLanes === undefined &&
                maxPeerConnections === undefined &&
                rttReportingDegreeLimit === undefined &&
                bootstrapDegree === undefined
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
                ...(rttReportingDegreeLimit !== undefined
                    ? { rttReportingDegreeLimit }
                    : {}),
                ...(bootstrapDegree !== undefined ? { bootstrapDegree } : {})
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
        endedAuthSessionKeys: () => state.endedAuthSessionKeys
    };
}

export function cloneRallarRuntimeDefaults(
    defaults: RallarDefaults
): RallarDefaults {
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
                        : {})
                }
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
                        : {})
                }
            }
            : {}),
        ...(defaults.messages
            ? { messages: { ...defaults.messages } }
            : {}),
        ...(defaults.operations
            ? { operations: { ...defaults.operations } }
            : {})
    };
}
