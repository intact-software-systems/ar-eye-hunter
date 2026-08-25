import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import { BrowserRtcDiagnosticsRuntime } from '@shared-web/browser/rtc-diagnostics/browser-rtc-diagnostics-runtime.ts';
import { BrowserRtcLifecycleRuntime } from '@shared-web/browser/rtc/browser-rtc-lifecycle-runtime.ts';
import { BrowserRtcRecoveryRuntime } from '@shared-web/browser/rtc/browser-rtc-recovery-runtime.ts';
import { BrowserRtcRoomRuntime } from '@shared-web/browser/rtc/browser-rtc-room-runtime.ts';
import { BrowserRtcStatusRuntime } from '@shared-web/browser/rtc/browser-rtc-status-runtime.ts';
import { BrowserRtcWaitRuntime } from '@shared-web/browser/rtc/browser-rtc-wait-runtime.ts';
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

/** Constructs the public RTC capability from its status, lifecycle, wait, room, diagnostic, and recovery owners. */
export class BrowserRallarRtcController {
    public readonly lifecycle: BrowserRtcLifecycleRuntime;
    public readonly operations: RallarRtcFacade;

    public constructor(input: BrowserRallarRtcController.Input) {
        const status = new BrowserRtcStatusRuntime({
            readMiddleware: input.readMiddleware,
            readSession: input.readSession
        });
        this.lifecycle = new BrowserRtcLifecycleRuntime({
            readMiddleware: input.readMiddleware,
            readStatus: (options) => status.read(options)
        });
        const wait = new BrowserRtcWaitRuntime({
            readMiddleware: input.readMiddleware,
            readStatus: (options) => status.read(options),
            resolveRoomPeerIds: input.resolveRoomPeerIds,
            resolveWaitTimeoutMs: input.resolveRtcWaitTimeoutMs,
            resolveConnectOnWait: input.resolveRtcConnectOnWait
        });
        const rooms = new BrowserRtcRoomRuntime({
            readWsStatus: input.readWsStatus,
            readRtcStatus: (options) => status.read(options),
            resolveRoomPeerIds: input.resolveRoomPeerIds,
            resolveRoomRef: input.resolveRoomRef,
            toRoomId: input.toRoomId,
            waitForRoomLane: async (room, laneId, options) =>
                await wait.waitForRoomLane(room, laneId, options)
        });
        const diagnostics = new BrowserRtcDiagnosticsRuntime({
            readMiddleware: input.readMiddleware,
            readSession: input.readSession,
            readStatus: (options) => status.read(options)
        });
        const recovery = new BrowserRtcRecoveryRuntime({
            readMiddleware: input.readMiddleware,
            readStatus: () => status.read(),
            waitForLane: async (peerId, laneId, options) =>
                await wait.waitForLane(peerId, laneId, options)
        });

        this.operations = {
            status: (options) => status.read(options),
            roomStatus: (room, options) => rooms.status(room, options),
            openRoom: async (room, options) => await rooms.open(room, options),
            waitForRoom: async (room, options) => await rooms.wait(room, options),
            onStatus: (listener, options = {}) =>
                this.lifecycle.onStatus(listener, options),
            onLifecycle: (listener, options = {}) =>
                this.lifecycle.onLifecycle(listener, options),
            waitForLane: async (peerId, laneId, options) =>
                await wait.waitForLane(peerId, laneId, options),
            waitForOpen: async (peerId, options = {}) =>
                await wait.waitForLane(
                    peerId,
                    options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                    options
                ),
            waitForRoomLane: async (room, laneId, options = {}) =>
                await wait.waitForRoomLane(options.roomRef ?? room, laneId, options),
            peer: (peerId, options) => status.peer(peerId, options),
            knownPeerIds: () => status.knownPeerIds(),
            activePeerIds: () => status.activePeerIds(),
            peerIdsWithNoReconnectableLanes: () =>
                status.peerIdsWithNoReconnectableLanes(),
            readyPeerIds: (laneId) => status.readyPeerIds(laneId),
            diagnostics: async (options) => await diagnostics.read(options),
            restartIce: async (peerId) => await recovery.restartIce(peerId),
            reconnectPeer: async (peerId, options) =>
                await recovery.reconnectPeer(peerId, options)
        };
    }
}
