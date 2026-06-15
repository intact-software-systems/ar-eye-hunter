import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcLifecycleListener,
    RallarRtcPeerStatus,
    RallarRtcReconnectOptions,
    RallarRtcRecoveryResult,
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomTransportOptions,
    RallarRtcStatus,
    RallarRtcStatusListener,
    RallarRtcStatusOptions,
    RallarRtcStatusSubscriptionOptions,
    RallarRtcWaitForOpenOptions,
    RallarRtcWaitForOpenResult,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar.ts';

export type RallarRtcFacade = Readonly<{
    status(options?: RallarRtcStatusOptions): RallarRtcStatus;
    roomStatus(
        room: string | GroupRef,
        options?: RallarRtcRoomTransportOptions,
    ): RallarRoomTransportStatus;
    openRoom(
        room: string | GroupRef,
        options?: RallarRtcRoomTransportOptions,
    ): Promise<RallarRoomTransportStatus>;
    waitForRoom(
        room: string | GroupRef,
        options?: RallarRtcRoomTransportOptions,
    ): Promise<RallarRoomTransportStatus>;
    onStatus(
        listener: RallarRtcStatusListener,
        options?: RallarRtcStatusSubscriptionOptions,
    ): RallarUnsubscribe;
    onLifecycle(
        listener: RallarRtcLifecycleListener,
        options?: RallarRtcStatusSubscriptionOptions,
    ): RallarUnsubscribe;
    waitForLane(
        peerId: string,
        laneId: string,
        options?: RallarRtcWaitForOpenOptions,
    ): Promise<RallarRtcWaitForOpenResult>;
    waitForOpen(
        peerId: string,
        options?: RallarRtcWaitForOpenOptions,
    ): Promise<RallarRtcWaitForOpenResult>;
    waitForRoomLane(
        room: string | GroupRef,
        laneId: string,
        options?: RallarRtcRoomLaneWaitOptions,
    ): Promise<RallarRtcRoomLaneWaitResult>;
    peer(
        peerId: string,
        options?: RallarRtcStatusOptions,
    ): RallarRtcPeerStatus | undefined;
    knownPeerIds(): readonly string[];
    activePeerIds(): readonly string[];
    peerIdsWithNoReconnectableLanes(): readonly string[];
    readyPeerIds(laneId?: string): readonly string[];
    diagnostics(
        options?: RallarRtcDiagnosticsOptions,
    ): Promise<RallarRtcDiagnostics>;
    restartIce(peerId: string): Promise<RallarRtcRecoveryResult>;
    reconnectPeer(
        peerId: string,
        options?: RallarRtcReconnectOptions,
    ): Promise<RallarRtcRecoveryResult>;
}>;

export type CreateRallarRtcFacadeOptions = RallarRtcFacade;

export function createRallarRtcFacade(
    operations: CreateRallarRtcFacadeOptions,
): RallarRtcFacade {
    return {
        status: (
            options: RallarRtcStatusOptions = {},
        ): RallarRtcStatus => operations.status(options),
        roomStatus: (
            room,
            options: RallarRtcRoomTransportOptions = {},
        ): RallarRoomTransportStatus => operations.roomStatus(room, options),
        openRoom: async (
            room,
            options: RallarRtcRoomTransportOptions = {},
        ): Promise<RallarRoomTransportStatus> =>
            await operations.openRoom(room, options),
        waitForRoom: async (
            room,
            options: RallarRtcRoomTransportOptions = {},
        ): Promise<RallarRoomTransportStatus> =>
            await operations.waitForRoom(room, options),
        onStatus: (
            listener,
            options: RallarRtcStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => operations.onStatus(listener, options),
        onLifecycle: (
            listener,
            options: RallarRtcStatusSubscriptionOptions = {},
        ): RallarUnsubscribe => operations.onLifecycle(listener, options),
        waitForLane: async (
            peerId,
            laneId,
            options: RallarRtcWaitForOpenOptions = {},
        ): Promise<RallarRtcWaitForOpenResult> =>
            await operations.waitForLane(peerId, laneId, options),
        waitForOpen: async (
            peerId,
            options: RallarRtcWaitForOpenOptions = {},
        ): Promise<RallarRtcWaitForOpenResult> =>
            await operations.waitForOpen(peerId, options),
        waitForRoomLane: async (
            room,
            laneId,
            options: RallarRtcRoomLaneWaitOptions = {},
        ): Promise<RallarRtcRoomLaneWaitResult> =>
            await operations.waitForRoomLane(room, laneId, options),
        peer: (
            peerId,
            options: RallarRtcStatusOptions = {},
        ): RallarRtcPeerStatus | undefined => operations.peer(peerId, options),
        knownPeerIds: (): readonly string[] => operations.knownPeerIds(),
        activePeerIds: (): readonly string[] => operations.activePeerIds(),
        peerIdsWithNoReconnectableLanes: (): readonly string[] =>
            operations.peerIdsWithNoReconnectableLanes(),
        readyPeerIds: (laneId?: string): readonly string[] =>
            operations.readyPeerIds(laneId),
        diagnostics: async (
            options: RallarRtcDiagnosticsOptions = {},
        ): Promise<RallarRtcDiagnostics> =>
            await operations.diagnostics(options),
        restartIce: async (
            peerId,
        ): Promise<RallarRtcRecoveryResult> =>
            await operations.restartIce(peerId),
        reconnectPeer: async (
            peerId,
            options: RallarRtcReconnectOptions = {},
        ): Promise<RallarRtcRecoveryResult> =>
            await operations.reconnectPeer(peerId, options),
    };
}
