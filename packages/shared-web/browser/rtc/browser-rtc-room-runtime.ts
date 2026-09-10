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
        subscribeRtcStatus(
            laneId: string,
            listener: () => void | Promise<void>
        ): RallarUnsubscribe;
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
        | Readonly<{ waitStatus: 'open' | 'timeout' | 'aborted'; }>
        | Readonly<{ lane: RallarRtcRoomLaneWaitResult; }>;
}

interface RoomTransportObservation {
    readonly target: BrowserRoomTransportTarget;
    readonly readyPeerCount: number;
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
        const observedWaitStatus = readiness && 'waitStatus' in readiness
            ? readiness.waitStatus
            : undefined;
        const waitStatus = laneReadiness?.status ?? observedWaitStatus;
        const observedWaitFailed = observedWaitStatus === 'timeout' ||
            observedWaitStatus === 'aborted';
        const state = resolveRtcRoomTransportState({
            mode,
            hasAcceptedLayout: !observedWaitFailed &&
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
        options: RallarRtcRoomTransportOptions & Readonly<{ connect: boolean; }>
    ): Promise<BrowserRtcRoomRuntime.Readiness> {
        if (!this.input.isConnected()) {
            return { lane: await this.input.waitForRoomLane(room, laneId, options) };
        }

        const timeoutMs = normalizeWaitTimeoutMs(
            this.input.resolveWaitTimeoutMs(options.timeoutMs)
        );
        if (options.connect === false) {
            return await this.waitForObservedRoomReadiness(room, laneId, options, timeoutMs);
        }

        const target = this.input.resolveRoomTransportTarget(room);
        if (isRoomTransportConnectTargetSettled(target, options.minReadyPeers)) {
            return { lane: await this.input.waitForRoomLane(room, laneId, options) };
        }

        const startedAtMs = Date.now();
        const readAuthority = (
            status: RoomTransportObservation['status'] = 'current'
        ): RoomTransportObservation => this.readObservation(room, laneId, status);
        const observation = await waitForSettledRead({
            readResult: readAuthority,
            isSettled: (current) =>
                isRoomTransportConnectTargetSettled(
                    current.target,
                    options.minReadyPeers
                ),
            subscribe: (listener) => this.input.subscribeRoomTransportTarget(room, listener),
            signal: options.signal,
            timeoutMs,
            toTimedOut: () => readAuthority('timeout'),
            toAborted: () => readAuthority('aborted')
        });
        if (
            !isRoomTransportConnectTargetSettled(
                observation.target,
                options.minReadyPeers
            )
        ) {
            return {
                waitStatus: observation.status === 'aborted'
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

    private async waitForObservedRoomReadiness(
        room: string | GroupRef,
        laneId: string,
        options: RallarRtcRoomTransportOptions & Readonly<{ connect: boolean; }>,
        timeoutMs: number
    ): Promise<BrowserRtcRoomRuntime.Readiness> {
        const minReadyPeers = options.minReadyPeers;
        const readReadiness = (
            status: RoomTransportObservation['status'] = 'current'
        ): RoomTransportObservation => this.readObservation(room, laneId, status);
        const observation = await waitForSettledRead({
            readResult: readReadiness,
            isSettled: (current) => isRoomTransportReadinessSettled(current, minReadyPeers),
            subscribe: (listener) => this.subscribeReadiness(room, laneId, listener),
            signal: options.signal,
            timeoutMs,
            toTimedOut: () => readReadiness('timeout'),
            toAborted: () => readReadiness('aborted')
        });
        return {
            waitStatus: observation.status === 'current'
                ? 'open'
                : observation.status
        };
    }

    private readObservation(
        room: string | GroupRef,
        laneId: string,
        status: RoomTransportObservation['status']
    ): RoomTransportObservation {
        const target = this.input.resolveRoomTransportTarget(room);
        return {
            target,
            readyPeerCount: selectRtcRoomPeers(
                this.input.readRtcStatus({ laneId }),
                target.peerIds,
                laneId
            ).readyPeerIds.length,
            status
        };
    }

    private subscribeReadiness(
        room: string | GroupRef,
        laneId: string,
        listener: () => void | Promise<void>
    ): RallarUnsubscribe {
        const unsubscribeTarget = this.input.subscribeRoomTransportTarget(room, listener);
        const unsubscribeRtc = this.input.subscribeRtcStatus(laneId, listener);
        return () => {
            unsubscribeTarget();
            unsubscribeRtc();
        };
    }
}

function isRoomTransportConnectTargetSettled(
    target: BrowserRoomTransportTarget,
    minReadyPeers: number | undefined
): boolean {
    if (target.transportState === 'halted') {
        return true;
    }
    return target.acceptedLayoutCoversCurrentPresence &&
        (minReadyPeers === undefined ||
            minReadyPeers <= 0 ||
            target.peerIds.length >= minReadyPeers);
}

function isRoomTransportReadinessSettled(
    observation: RoomTransportObservation,
    minReadyPeers: number | undefined
): boolean {
    const { target, readyPeerCount } = observation;
    if (target.transportState === 'halted') {
        return true;
    }
    if (!target.acceptedLayoutCoversCurrentPresence) {
        return false;
    }
    const desiredPeerCount = target.peerIds.length;
    if (minReadyPeers !== undefined && minReadyPeers > 0) {
        return readyPeerCount >= minReadyPeers;
    }
    return desiredPeerCount === 0 || readyPeerCount === desiredPeerCount;
}
