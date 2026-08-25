import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarDefaults } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { readGroupId } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';

export type RallarBrowserConnectStatus = 'idle' | 'connecting' | 'connected';

export interface RallarBrowserFacadeRuntimeContext {
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
    resolveOperationOptions<T extends RallarOperationOptions>(options: T): T & RallarOperationOptions;
    readAuthExpiryTimer(): ReturnType<typeof setTimeout> | undefined;
    setAuthExpiryTimer(timer: ReturnType<typeof setTimeout> | undefined): void;
    clearAuthExpiryTimer(): void;
    readAuthEndPromise(): Promise<void> | undefined;
    setAuthEndPromise(promise: Promise<void> | undefined): void;
    endedAuthSessionKeys(): Set<string>;
}

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

interface BrowserCurrentRoomState {
    readonly id: string;
    readonly ref: GroupRef;
}

/** Mutable session state shared by the completed browser facade capabilities. */
export class BrowserFacadeRuntimeState implements RallarBrowserFacadeRuntimeContext {
    private connectState: RallarBrowserConnectStatus = 'idle';
    private stateCacheUnsubscribe: (() => void) | undefined;
    private currentRoom: BrowserCurrentRoomState | undefined;
    private runtimeDefaults: RallarDefaults | undefined;
    private defaultScope: StateScope | undefined;
    private authExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    private authEndPromise: Promise<void> | undefined;
    private readonly endedSessionKeys = new Set<string>();
    private readonly transportRuntime: BrowserTransportRuntimePort;

    public constructor(transportRuntime: BrowserTransportRuntimePort) {
        this.transportRuntime = transportRuntime;
    }

    public readonly readConnectState = (): RallarBrowserConnectStatus => {
        return this.connectState;
    };

    public readonly setConnectState = (connectState: RallarBrowserConnectStatus): void => {
        this.connectState = connectState;
    };

    public readonly readMiddleware = (): ApiMiddleware | undefined => {
        return this.transportRuntime.readMiddleware();
    };

    public readonly requireMiddleware = (): ApiMiddleware => {
        return this.transportRuntime.requireMiddleware();
    };

    public readonly readStateCacheUnsubscribe = (): (() => void) | undefined => {
        return this.stateCacheUnsubscribe;
    };

    public readonly setStateCacheUnsubscribe = (
        unsubscribe: (() => void) | undefined
    ): void => {
        this.stateCacheUnsubscribe = unsubscribe;
    };

    public readonly currentRoomId = (): string | undefined => {
        return this.currentRoom?.id;
    };

    public readonly currentRoomRef = (): GroupRef | undefined => {
        return this.currentRoom?.ref;
    };

    public readonly setCurrentRoom = (snapshot: GroupSnapshot): void => {
        this.currentRoom = { id: readGroupId(snapshot), ref: snapshot.group };
    };

    public readonly clearCurrentRoom = (): void => {
        this.currentRoom = undefined;
    };

    public readonly clearCurrentRoomIfMatches = (
        room: string | GroupRef,
        clearCurrent: boolean
    ): void => {
        if (!clearCurrent || !this.currentRoom) {
            return;
        }
        const matches = typeof room === 'string'
            ? this.currentRoom.id === room
            : isSameGroupRef(this.currentRoom.ref, room);
        if (matches) {
            this.currentRoom = undefined;
        }
    };

    public readonly setDefaults = (defaults?: RallarDefaults): void => {
        this.runtimeDefaults = defaults
            ? cloneRallarRuntimeDefaults(defaults)
            : undefined;
        this.defaultScope = defaults
            ? {
                applicationId: defaults.applicationId,
                workspaceId: defaults.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID
            }
            : undefined;
    };

    public readonly defaults = (): RallarDefaults | undefined => {
        return this.runtimeDefaults
            ? cloneRallarRuntimeDefaults(this.runtimeDefaults)
            : undefined;
    };

    public readonly readDefaults = (): RallarDefaults | undefined => {
        return this.runtimeDefaults;
    };

    public readonly readDefaultScope = (): StateScope | undefined => {
        return this.defaultScope;
    };

    public readonly resolveOperationScope = (scope?: StateScope): StateScope | undefined => {
        return scope ?? this.defaultScope;
    };

    public readonly resolveOperationOptions = <T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions => {
        const operationDefaults = this.runtimeDefaults?.operations;
        const rtcDefaults = this.runtimeDefaults?.rtc;
        const resolved = {
            timeoutMs: options.timeoutMs ?? operationDefaults?.timeoutMs,
            maxAttempts: options.maxAttempts ?? operationDefaults?.maxAttempts,
            shouldRetry: options.shouldRetry ?? operationDefaults?.shouldRetry,
            dataChannelLanes: options.dataChannelLanes ?? rtcDefaults?.dataChannelLanes,
            maxPeerConnections: options.maxPeerConnections ?? rtcDefaults?.maxPeerConnections,
            rttReportingDegreeLimit: options.rttReportingDegreeLimit ??
                rtcDefaults?.rttReportingDegreeLimit,
            bootstrapDegree: options.bootstrapDegree ?? rtcDefaults?.bootstrapDegree
        };
        if (Object.values(resolved).every((value) => value === undefined)) {
            return options;
        }
        return {
            ...options,
            ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
            ...(resolved.maxAttempts !== undefined ? { maxAttempts: resolved.maxAttempts } : {}),
            ...(resolved.shouldRetry !== undefined ? { shouldRetry: resolved.shouldRetry } : {}),
            ...(resolved.dataChannelLanes !== undefined
                ? { dataChannelLanes: resolved.dataChannelLanes }
                : {}),
            ...(resolved.maxPeerConnections !== undefined
                ? { maxPeerConnections: resolved.maxPeerConnections }
                : {}),
            ...(resolved.rttReportingDegreeLimit !== undefined
                ? { rttReportingDegreeLimit: resolved.rttReportingDegreeLimit }
                : {}),
            ...(resolved.bootstrapDegree !== undefined
                ? { bootstrapDegree: resolved.bootstrapDegree }
                : {})
        };
    };

    public readonly readAuthExpiryTimer = (): ReturnType<typeof setTimeout> | undefined => {
        return this.authExpiryTimer;
    };

    public readonly setAuthExpiryTimer = (
        timer: ReturnType<typeof setTimeout> | undefined
    ): void => {
        this.authExpiryTimer = timer;
    };

    public readonly clearAuthExpiryTimer = (): void => {
        if (this.authExpiryTimer !== undefined) {
            clearTimeout(this.authExpiryTimer);
            this.authExpiryTimer = undefined;
        }
    };

    public readonly readAuthEndPromise = (): Promise<void> | undefined => {
        return this.authEndPromise;
    };

    public readonly setAuthEndPromise = (promise: Promise<void> | undefined): void => {
        this.authEndPromise = promise;
    };

    public readonly endedAuthSessionKeys = (): Set<string> => {
        return this.endedSessionKeys;
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
