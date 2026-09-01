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
    resolveRtcRoomTransportState,
    selectRtcRoomPeers
} from '@shared-web/browser/rtc/rtc-room-transport-status.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/web-rtc-connection-service.ts';

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
        const peers = selectRtcRoomPeers(this.input.readRtcStatus({ laneId }), desiredPeerIds, laneId);
        const minReadyPeers = Math.max(
            0,
            options.minReadyPeers ?? desiredPeerIds.length
        );
        const state = resolveRtcRoomTransportState({
            mode,
            hasAcceptedLayout: target.acceptedLayoutIdentity !== undefined,
            transportState: target.transportState,
            desiredPeerCount: desiredPeerIds.length,
            knownPeerCount: peers.knownPeerIds.length,
            activePeerCount: peers.activePeerIds.length,
            readyPeerCount: peers.readyPeerIds.length,
            failedPeerCount: peers.failedPeerIds.length,
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
                ...peers,
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
        const pinnedRoom = this.input.resolveRoomRef(room) ?? room;
        const readiness = await this.input.waitForRoomLane(pinnedRoom, laneId, {
            ...options,
            connect: true
        });

        return this.status(pinnedRoom, { ...options, mode, laneId }, readiness);
    }

    public async wait(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {}
    ): Promise<RallarRoomTransportStatus> {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const pinnedRoom = this.input.resolveRoomRef(room) ?? room;
        const readiness = await this.input.waitForRoomLane(pinnedRoom, laneId, {
            ...options,
            connect: options.connect ?? true
        });

        return this.status(pinnedRoom, { ...options, laneId }, readiness);
    }
}
