import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRoomTransportStatus,
    RallarRtcFacade,
    RallarRtcReconnectOptions,
    RallarRtcRecoveryResult,
    RallarRtcRecoveryStatus,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomTransportOptions
} from '@shared-web/browser/rallar-rtc-facade.ts';
import { BrowserRtcDiagnosticsRuntime } from '@shared-web/browser/rtc-diagnostics/browser-rtc-diagnostics-runtime.ts';
import { BrowserRtcObservationRuntime } from '@shared-web/browser/rtc-diagnostics/browser-rtc-observation-runtime.ts';
import { BrowserRtcWaitRuntime } from '@shared-web/browser/rtc/browser-rtc-wait-runtime.ts';
import {
    describeRtcRoomTransport,
    resolveRtcRoomTransportState
} from '@shared-web/browser/rtc/rtc-room-transport-status.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID } from '@shared/services/WebRtcConnectionService.ts';

export namespace BrowserRallarRtcController {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readSession(): AuthSession | undefined;
        readWsStatus(): RallarWsStatus;
        resolveRoomPeerIds(room: string | GroupRef): readonly string[];
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        resolveRtcWaitTimeoutMs(timeoutMs?: number): number | undefined;
        resolveRtcConnectOnWait(connect?: boolean): boolean;
    }
}

interface RallarRtcRecoveryResultInput {
    readonly peerId: string;
    readonly action: RallarRtcRecoveryResult['action'];
    readonly status: RallarRtcRecoveryStatus;
    readonly reason?: string;
}

export class BrowserRallarRtcController {
    private readonly diagnostics: BrowserRtcDiagnosticsRuntime;
    private readonly input: BrowserRallarRtcController.Input;
    private readonly observation: BrowserRtcObservationRuntime;
    private readonly wait: BrowserRtcWaitRuntime;

    constructor(input: BrowserRallarRtcController.Input) {
        this.input = input;
        this.observation = new BrowserRtcObservationRuntime({
            readMiddleware: input.readMiddleware,
            readSession: input.readSession
        });
        this.diagnostics = new BrowserRtcDiagnosticsRuntime({
            readMiddleware: input.readMiddleware,
            readSession: input.readSession,
            readStatus: (statusOptions) => this.observation.status(statusOptions)
        });
        this.wait = new BrowserRtcWaitRuntime({
            readMiddleware: input.readMiddleware,
            readStatus: (statusOptions) => this.observation.status(statusOptions),
            resolveRoomPeerIds: input.resolveRoomPeerIds,
            resolveWaitTimeoutMs: input.resolveRtcWaitTimeoutMs,
            resolveConnectOnWait: input.resolveRtcConnectOnWait
        });
    }

    readonly operations: RallarRtcFacade = {
        status: (statusOptions) => this.observation.status(statusOptions),
        roomStatus: (room, roomOptions) => this.toRoomTransportStatus(room, roomOptions),
        openRoom: async (room, roomOptions) => await this.openRtcRoom(room, roomOptions),
        waitForRoom: async (room, roomOptions) => await this.waitForRtcRoom(room, roomOptions),
        onStatus: (listener, subscriptionOptions = {}) => this.observation.onStatus(listener, subscriptionOptions),
        onLifecycle: (listener, subscriptionOptions = {}) =>
            this.observation.onLifecycle(listener, subscriptionOptions),
        waitForLane: async (peerId, laneId, waitOptions) => await this.wait.waitForLane(peerId, laneId, waitOptions),
        waitForOpen: async (peerId, waitOptions = {}) =>
            await this.wait.waitForLane(
                peerId,
                waitOptions.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                waitOptions
            ),
        waitForRoomLane: async (room, laneId, waitOptions = {}) =>
            await this.wait.waitForRoomLane(
                waitOptions.roomRef ?? room,
                laneId,
                waitOptions
            ),
        peer: (peerId, statusOptions) => this.observation.peer(peerId, statusOptions),
        knownPeerIds: () => this.observation.knownPeerIds(),
        activePeerIds: () => this.observation.activePeerIds(),
        peerIdsWithNoReconnectableLanes: () => this.observation.peerIdsWithNoReconnectableLanes(),
        readyPeerIds: (laneId) => this.observation.readyPeerIds(laneId),
        diagnostics: async (diagnosticOptions) => await this.diagnostics.read(diagnosticOptions),
        restartIce: async (peerId) => await this.restartRtcIce(peerId),
        reconnectPeer: async (peerId, reconnectOptions) => await this.reconnectRtcPeer(peerId, reconnectOptions)
    };

    attach(ctx = this.input.readMiddleware()): void {
        this.observation.attach(ctx);
    }

    connected(): void {
        this.observation.connected();
    }

    detach(ctx = this.input.readMiddleware()): void {
        this.observation.detach(ctx);
    }

    disconnected(): void {
        this.observation.disconnected();
    }

    private async restartRtcIce(
        peerId: string
    ): Promise<RallarRtcRecoveryResult> {
        const ctx = this.input.readMiddleware();
        if (!ctx) {
            return this.toRtcRecoveryResult({
                peerId,
                action: 'restart-ice',
                status: 'not-connected',
                reason: 'Rallar is not connected.'
            });
        }

        const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
        if (!peer) {
            return this.toRtcRecoveryResult({
                peerId,
                action: 'restart-ice',
                status: 'no-peer',
                reason: `RTC peer ${peerId} is not known.`
            });
        }

        const pc = peer.connection.status.pc;
        if (!pc || typeof pc.restartIce !== 'function') {
            return this.toRtcRecoveryResult({
                peerId,
                action: 'restart-ice',
                status: 'unsupported',
                reason: `RTC peer ${peerId} does not expose restartIce().`
            });
        }

        try {
            pc.restartIce();
            return this.toRtcRecoveryResult({ peerId, action: 'restart-ice', status: 'restarted' });
        }
        catch (error) {
            return this.toRtcRecoveryResult({
                peerId,
                action: 'restart-ice',
                status: 'failed',
                reason: toErrorMessage(error)
            });
        }
    }

    private async reconnectRtcPeer(
        peerId: string,
        options: RallarRtcReconnectOptions = {}
    ): Promise<RallarRtcRecoveryResult> {
        const ctx = this.input.readMiddleware();
        if (!ctx) {
            return this.toRtcRecoveryResult({
                peerId,
                action: 'reconnect',
                status: 'not-connected',
                reason: 'Rallar is not connected.'
            });
        }

        try {
            ctx.middleware.webRtcConnectionService.disconnectPeer(peerId);
            const laneId = options.laneId;
            if (laneId) {
                const result = await this.wait.waitForLane(
                    peerId,
                    laneId,
                    {
                        ...options,
                        connect: true
                    }
                );
                return this.toRtcRecoveryResult({
                    peerId,
                    action: 'reconnect',
                    status: result.status === 'open' ? 'started' : 'failed',
                    reason: result.reason
                });
            }

            const started = ctx.middleware.webRtcConnectionService
                .ensurePeerConnectionStarted(peerId);
            if (started.left) {
                return this.toRtcRecoveryResult({
                    peerId,
                    action: 'reconnect',
                    status: 'failed',
                    reason: started.left.kind
                });
            }

            return this.toRtcRecoveryResult({ peerId, action: 'reconnect', status: 'started' });
        }
        catch (error) {
            return this.toRtcRecoveryResult({
                peerId,
                action: 'reconnect',
                status: 'failed',
                reason: toErrorMessage(error)
            });
        }
    }

    private toRtcRecoveryResult(input: RallarRtcRecoveryResultInput): RallarRtcRecoveryResult {
        return {
            peerId: input.peerId,
            action: input.action,
            status: input.status,
            rtcStatus: this.observation.status(),
            reason: input.reason
        };
    }

    private async openRtcRoom(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {}
    ): Promise<RallarRoomTransportStatus> {
        const mode = options.mode ?? 'lazy';
        if (mode === 'off' || mode === 'lazy') {
            return this.toRoomTransportStatus(room, {
                ...options,
                mode
            });
        }

        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.wait.waitForRoomLane(
            room,
            laneId,
            {
                ...options,
                connect: true
            }
        );

        return this.toRoomTransportStatus(room, {
            ...options,
            mode,
            laneId
        }, readiness);
    }

    private async waitForRtcRoom(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {}
    ): Promise<RallarRoomTransportStatus> {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.wait.waitForRoomLane(
            room,
            laneId,
            {
                ...options,
                connect: options.connect ?? true
            }
        );

        return this.toRoomTransportStatus(room, {
            ...options,
            laneId
        }, readiness);
    }

    private toRoomTransportStatus(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
        readiness?: RallarRtcRoomLaneWaitResult
    ): RallarRoomTransportStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const mode = options.mode ?? 'lazy';
        const roomRef = this.input.resolveRoomRef(room);
        const roomId = this.input.toRoomId(room);
        const desiredPeerIds = this.input.resolveRoomPeerIds(roomRef ?? room);
        const desiredPeerIdSet = new Set(desiredPeerIds);
        const rtcStatus = this.observation.status({ laneId });
        const knownPeerIds = rtcStatus.knownPeerIds.filter((peerId) => desiredPeerIdSet.has(peerId));
        const activePeerIds = rtcStatus.activePeerIds.filter((peerId) => desiredPeerIdSet.has(peerId));
        const readyPeerIds = rtcStatus.readyPeerIds.filter((peerId) => desiredPeerIdSet.has(peerId));
        const failedPeerIds = rtcStatus.peerIdsWithNoReconnectableLanes.filter(
            (peerId) => desiredPeerIdSet.has(peerId)
        );
        const minReadyPeers = Math.max(
            0,
            options.minReadyPeers ?? desiredPeerIds.length
        );
        const state = resolveRtcRoomTransportState({
            mode,
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
                desiredPeerIds,
                knownPeerIds,
                activePeerIds,
                readyPeerIds,
                failedPeerIds,
                laneId,
                lastChangedAtEpochMs: Date.now(),
                reason: describeRtcRoomTransport(state, readiness)
            }
        };
    }
}

function toErrorMessage(error: Error['cause']): string {
    return error instanceof Error ? error.message : String(error);
}
