import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomTransportOptions,
    RallarRtcStatus,
    RallarRtcStatusOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { BrowserRoomTransportTarget } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import {
    describeRtcRoomTransport,
    resolveRtcRoomTransportState
} from '@shared-web/browser/rtc/rtc-room-transport-status.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';

export namespace BrowserRtcRoomRuntime {
    export interface Input {
        readWsStatus(): RallarWsStatus;
        readRtcStatus(options?: RallarRtcStatusOptions): RallarRtcStatus;
        resolveRoomTransportTarget(room: string | GroupRef): BrowserRoomTransportTarget;
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        waitForRoomLane(
            room: string | GroupRef,
            laneId: string,
            options: RallarRtcRoomLaneWaitOptions
        ): Promise<RallarRtcRoomLaneWaitResult>;
    }
}

/** Owns room-scoped RTC transport status, opening, and readiness views. */
export class BrowserRtcRoomRuntime {
    private readonly input: BrowserRtcRoomRuntime.Input;

    public constructor(input: BrowserRtcRoomRuntime.Input) {
        this.input = input;
    }

    public status(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
        readiness?: RallarRtcRoomLaneWaitResult
    ): RallarRoomTransportStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const mode = options.mode ?? 'lazy';
        const roomRef = this.input.resolveRoomRef(room);
        const roomId = this.input.toRoomId(room);
        const target = this.input.resolveRoomTransportTarget(roomRef ?? room);
        const desiredPeerIds = target.peerIds;
        const desiredPeerIdSet = new Set(desiredPeerIds);
        const filterRoomPeerIds = (peerIds: readonly string[]): readonly string[] =>
            peerIds.filter((peerId) => desiredPeerIdSet.has(peerId));
        const rtcStatus = this.input.readRtcStatus({ laneId });
        const knownPeerIds = filterRoomPeerIds(rtcStatus.knownPeerIds);
        const activePeerIds = filterRoomPeerIds(rtcStatus.activePeerIds);
        const readyPeerIds = filterRoomPeerIds(rtcStatus.readyPeerIds);
        const failedPeerIds = filterRoomPeerIds(
            rtcStatus.peerIdsWithNoReconnectableLanes
        );
        const peers = rtcStatus.peers.filter((peer) => desiredPeerIdSet.has(peer.peerId));
        const minReadyPeers = Math.max(
            0,
            options.minReadyPeers ?? desiredPeerIds.length
        );
        const state = resolveRtcRoomTransportState({
            mode,
            hasAcceptedLayout: target.acceptedLayoutIdentity !== undefined,
            transportState: target.transportState,
            desiredPeerCount: desiredPeerIds.length,
            knownPeerCount: knownPeerIds.length,
            activePeerCount: activePeerIds.length,
            readyPeerCount: readyPeerIds.length,
            failedPeerCount: failedPeerIds.length,
            minReadyPeers,
            waitStatus: readiness?.status
        });

        return {
            roomRef,
            roomId,
            ws: this.input.readWsStatus(),
            rtc: {
                desired: mode !== 'off',
                mode,
                state,
                acceptedLayoutIdentity: target.acceptedLayoutIdentity,
                desiredPeerIds,
                knownPeerIds,
                activePeerIds,
                readyPeerIds,
                failedPeerIds,
                peers,
                laneId,
                lastChangedAtEpochMs: Date.now(),
                reason: describeRtcRoomTransport(state, readiness)
            }
        };
    }

    public async open(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {}
    ): Promise<RallarRoomTransportStatus> {
        const mode = options.mode ?? 'lazy';
        if (mode === 'off' || mode === 'lazy') {
            return this.status(room, { ...options, mode });
        }

        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.input.waitForRoomLane(room, laneId, {
            ...options,
            connect: true
        });

        return this.status(room, { ...options, mode, laneId }, readiness);
    }

    public async wait(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {}
    ): Promise<RallarRoomTransportStatus> {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.input.waitForRoomLane(room, laneId, {
            ...options,
            connect: options.connect ?? true
        });

        return this.status(room, { ...options, laneId }, readiness);
    }
}
