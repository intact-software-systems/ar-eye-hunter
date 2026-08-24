import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarOnChangeOptions, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarReadinessExpectation } from '@shared-web/browser/readiness.ts';
import type {
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcLaneStatus,
    RallarRtcPeerStatus,
    RallarRtcStatus
} from '@shared-web/browser/rtc-diagnostics/rallar-rtc-diagnostics-contracts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type {
    RallarRtcCandidateDiagnostics,
    RallarRtcCandidatePairDiagnostics,
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcLaneStatus,
    RallarRtcPeerConnectionStatus,
    RallarRtcPeerDiagnostics,
    RallarRtcPeerStatus,
    RallarRtcStatus
} from '@shared-web/browser/rtc-diagnostics/rallar-rtc-diagnostics-contracts.ts';

export type RallarWaitForOpenStatus =
    | 'open'
    | 'timeout'
    | 'aborted'
    | 'not-connected'
    | 'closed'
    | 'no-peer'
    | 'no-lane'
    | 'failed';

export interface RallarWaitForOpenOptions {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export type RallarRtcWaitForOpenOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
        laneId?: string;
        connect?: boolean;
    }>;

export type RallarRtcRoomLaneWaitOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
        connect?: boolean;
        roomRef?: GroupRef;
        expect?: RallarReadinessExpectation;
    }>;

export type RallarRtcRoomLaneWaitStatus =
    | 'open'
    | 'partial'
    | 'not-ready'
    | 'empty'
    | 'over-capacity'
    | 'not-connected'
    | 'timeout'
    | 'aborted'
    | 'failed';

export type RallarRtcRoomMode = 'off' | 'lazy' | 'warm' | 'eager';

export type RallarRoomTransportState =
    | 'off'
    | 'idle'
    | 'connecting'
    | 'partial'
    | 'open'
    | 'degraded'
    | 'failed';

export interface RallarRoomTransportStatus {
    readonly roomRef?: GroupRef;
    readonly roomId?: string;
    readonly ws: RallarWsStatus;
    readonly rtc: Readonly<{
        desired: boolean;
        mode: RallarRtcRoomMode;
        state: RallarRoomTransportState;
        desiredPeerIds: readonly string[];
        knownPeerIds: readonly string[];
        activePeerIds: readonly string[];
        readyPeerIds: readonly string[];
        failedPeerIds: readonly string[];
        laneId: string;
        lastChangedAtEpochMs?: number;
        reason?: string;
    }>;
}

export type RallarRtcRoomTransportOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
        laneId?: string;
        mode?: RallarRtcRoomMode;
        minReadyPeers?: number;
        connect?: boolean;
    }>;

export interface RallarRtcStatusOptions {
    readonly laneId?: string;
}

export type RallarRtcStatusSubscriptionOptions =
    & RallarRtcStatusOptions
    & RallarOnChangeOptions;

export type RallarRtcStatusListener = (
    status: RallarRtcStatus
) => void | Promise<void>;

export type RallarRtcLifecycleKind =
    | 'snapshot'
    | 'connected'
    | 'disconnected'
    | 'peer-created'
    | 'peer-deleted'
    | 'peer-timeout'
    | 'lane-open'
    | 'lane-close'
    | 'lane-error';

export interface RallarRtcLifecycleEvent {
    readonly kind: RallarRtcLifecycleKind;
    readonly atEpochMs: number;
    readonly status: RallarRtcStatus;
    readonly peerId?: string;
    readonly laneId?: string;
    readonly peer?: RallarRtcPeerStatus;
    readonly lane?: RallarRtcLaneStatus;
}

export type RallarRtcLifecycleListener = (
    event: RallarRtcLifecycleEvent
) => void | Promise<void>;

export type RallarRtcRecoveryStatus =
    | 'started'
    | 'restarted'
    | 'no-peer'
    | 'not-connected'
    | 'unsupported'
    | 'failed';

export interface RallarRtcRecoveryResult {
    readonly peerId: string;
    readonly action: 'restart-ice' | 'reconnect';
    readonly status: RallarRtcRecoveryStatus;
    readonly rtcStatus: RallarRtcStatus;
    readonly reason?: string;
}

export type RallarRtcReconnectOptions =
    & RallarWaitForOpenOptions
    & Readonly<{
        laneId?: string;
    }>;

export interface RallarRtcWaitForOpenResult {
    readonly transport: 'rtc';
    readonly status: RallarWaitForOpenStatus;
    readonly peerId: string;
    readonly laneId: string;
    readonly rtcStatus: RallarRtcStatus;
    readonly peer?: RallarRtcPeerStatus;
    readonly lane?: RallarRtcLaneStatus;
    readonly reason?: string;
}

export interface RallarRtcRoomLaneWaitResult {
    readonly transport: 'rtc';
    readonly roomId: string;
    readonly laneId: string;
    readonly status: RallarRtcRoomLaneWaitStatus;
    readonly rtcStatus: RallarRtcStatus;
    readonly ready: readonly RallarRtcWaitForOpenResult[];
    readonly notReady: readonly RallarRtcWaitForOpenResult[];
    readonly readyPeerIds: readonly string[];
    readonly notReadyPeerIds: readonly string[];
    readonly missingPeerIds: readonly string[];
    readonly extraPeerIds: readonly string[];
    readonly observedCount: number;
    readonly expectedCount?: number;
}

export interface RallarRtcFacade {
    status(options?: RallarRtcStatusOptions): RallarRtcStatus;
    roomStatus(room: string | GroupRef, options?: RallarRtcRoomTransportOptions): RallarRoomTransportStatus;
    openRoom(room: string | GroupRef, options?: RallarRtcRoomTransportOptions): Promise<RallarRoomTransportStatus>;
    waitForRoom(room: string | GroupRef, options?: RallarRtcRoomTransportOptions): Promise<RallarRoomTransportStatus>;
    onStatus(listener: RallarRtcStatusListener, options?: RallarRtcStatusSubscriptionOptions): RallarUnsubscribe;
    onLifecycle(listener: RallarRtcLifecycleListener, options?: RallarRtcStatusSubscriptionOptions): RallarUnsubscribe;
    waitForLane(
        peerId: string,
        laneId: string,
        options?: RallarRtcWaitForOpenOptions
    ): Promise<RallarRtcWaitForOpenResult>;
    waitForOpen(peerId: string, options?: RallarRtcWaitForOpenOptions): Promise<RallarRtcWaitForOpenResult>;
    waitForRoomLane(
        room: string | GroupRef,
        laneId: string,
        options?: RallarRtcRoomLaneWaitOptions
    ): Promise<RallarRtcRoomLaneWaitResult>;
    peer(peerId: string, options?: RallarRtcStatusOptions): RallarRtcPeerStatus | undefined;
    knownPeerIds(): readonly string[];
    activePeerIds(): readonly string[];
    peerIdsWithNoReconnectableLanes(): readonly string[];
    readyPeerIds(laneId?: string): readonly string[];
    diagnostics(options?: RallarRtcDiagnosticsOptions): Promise<RallarRtcDiagnostics>;
    restartIce(peerId: string): Promise<RallarRtcRecoveryResult>;
    reconnectPeer(peerId: string, options?: RallarRtcReconnectOptions): Promise<RallarRtcRecoveryResult>;
}
