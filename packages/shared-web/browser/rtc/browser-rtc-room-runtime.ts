import { normalizeWaitTimeoutMs } from '@shared-web/browser/connection/normalize-wait-timeout-ms.ts';
import { waitForSettledRead } from '@shared-web/browser/connection/wait-for-settled-read.ts';
import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomTransportOptions,
    RallarRtcStatus,
    RallarRtcStatusOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
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
        isConnected(): boolean;
        readWsStatus(): RallarWsStatus;
        readRtcStatus(options?: RallarRtcStatusOptions): RallarRtcStatus;
        resolveRoomTransportTarget(
            room: string | GroupRef
        ): BrowserRoomTransportTarget;
        subscribeRoomTransportTarget(
            room: string | GroupRef,
            listener: () => void | Promise<void>
        ): RallarUnsubscribe;
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        resolveWaitTimeoutMs(timeoutMs?: number): number | undefined;
        waitForRoomLane(
            room: string | GroupRef,
            laneId: string,
            options: RallarRtcRoomLaneWaitOptions
        ): Promise<RallarRtcRoomLaneWaitResult>;
    }

    export type Readiness =
        | Readonly<{ authorityWaitStatus: 'timeout' | 'aborted'; }>
        | Readonly<{ lane: RallarRtcRoomLaneWaitResult; }>;
}

interface RoomTransportAuthorityObservation {
    readonly target: BrowserRoomTransportTarget;
    readonly status: 'current' | 'timeout' | 'aborted';
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
        readiness?: BrowserRtcRoomRuntime.Readiness
    ): RallarRoomTransportStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const mode = options.mode ?? 'lazy';
        const roomRef = this.input.resolveRoomRef(room);
        const roomId = this.input.toRoomId(room);
        const target = this.input.resolveRoomTransportTarget(roomRef ?? room);
        const desiredPeerIds = target.peerIds;
        const peers = selectRtcRoomPeers(
            this.input.readRtcStatus({ laneId }),
            desiredPeerIds,
            laneId
        );
        const minReadyPeers = Math.max(
            0,
            options.minReadyPeers ?? desiredPeerIds.length
        );
        const laneReadiness = readiness && 'lane' in readiness
            ? readiness.lane
            : undefined;
        const authorityWaitStatus = readiness && 'authorityWaitStatus' in readiness
            ? readiness.authorityWaitStatus
            : undefined;
        const waitStatus = laneReadiness?.status ?? authorityWaitStatus;
        const state = resolveRtcRoomTransportState({
            mode,
            hasAcceptedLayout: authorityWaitStatus === undefined &&
                target.acceptedLayoutCoversCurrentPresence,
            transportState: target.transportState,
            desiredPeerCount: desiredPeerIds.length,
            knownPeerCount: peers.knownPeerIds.length,
            activePeerCount: peers.activePeerIds.length,
            readyPeerCount: peers.readyPeerIds.length,
            failedPeerCount: peers.failedPeerIds.length,
            minReadyPeers,
            waitStatus
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
                reason: describeRtcRoomTransport(state, waitStatus)
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
        const readiness = await this.waitForReadyRoomLane(pinnedRoom, laneId, {
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
        const readiness = await this.waitForReadyRoomLane(pinnedRoom, laneId, {
            ...options,
            connect: options.connect ?? true
        });

        return this.status(pinnedRoom, { ...options, laneId }, readiness);
    }

    private async waitForReadyRoomLane(
        room: string | GroupRef,
        laneId: string,
        options: RallarRtcRoomLaneWaitOptions
    ): Promise<BrowserRtcRoomRuntime.Readiness> {
        const target = this.input.resolveRoomTransportTarget(room);
        if (!this.input.isConnected() || isRoomTransportAuthoritySettled(target)) {
            return { lane: await this.input.waitForRoomLane(room, laneId, options) };
        }

        const timeoutMs = normalizeWaitTimeoutMs(
            this.input.resolveWaitTimeoutMs(options.timeoutMs)
        );
        const startedAtMs = Date.now();
        const readAuthority = (
            status: RoomTransportAuthorityObservation['status'] = 'current'
        ): RoomTransportAuthorityObservation => ({
            target: this.input.resolveRoomTransportTarget(room),
            status
        });
        const observation = await waitForSettledRead({
            readResult: readAuthority,
            isSettled: (current) => isRoomTransportAuthoritySettled(current.target),
            subscribe: (listener) => this.input.subscribeRoomTransportTarget(room, listener),
            signal: options.signal,
            timeoutMs,
            toTimedOut: () => readAuthority('timeout'),
            toAborted: () => readAuthority('aborted')
        });
        if (!isRoomTransportAuthoritySettled(observation.target)) {
            return {
                authorityWaitStatus: observation.status === 'aborted'
                    ? 'aborted'
                    : 'timeout'
            };
        }

        return {
            lane: await this.input.waitForRoomLane(room, laneId, {
                ...options,
                timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAtMs))
            })
        };
    }
}

function isRoomTransportAuthoritySettled(
    target: BrowserRoomTransportTarget
): boolean {
    return (
        target.transportState === 'halted' ||
        target.acceptedLayoutCoversCurrentPresence
    );
}
