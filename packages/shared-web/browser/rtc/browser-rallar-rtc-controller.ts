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

interface BrowserRtcRuntimes {
    readonly status: BrowserRtcStatusRuntime;
    readonly lifecycle: BrowserRtcLifecycleRuntime;
    readonly wait: BrowserRtcWaitRuntime;
    readonly rooms: BrowserRtcRoomRuntime;
    readonly diagnostics: BrowserRtcDiagnosticsRuntime;
    readonly recovery: BrowserRtcRecoveryRuntime;
}

/** Constructs the public RTC capability from its status, lifecycle, wait, room, diagnostic, and recovery owners. */
export class BrowserRallarRtcController {
    public readonly lifecycle: BrowserRtcLifecycleRuntime;
    public readonly operations: RallarRtcFacade;

    public constructor(input: BrowserRallarRtcController.Input) {
        const runtimes = createBrowserRtcRuntimes(input);
        this.lifecycle = runtimes.lifecycle;
        this.operations = createBrowserRtcOperations(runtimes);
    }
}

function createBrowserRtcRuntimes(
    input: BrowserRallarRtcController.Input
): BrowserRtcRuntimes {
    const status = new BrowserRtcStatusRuntime({
        readMiddleware: input.readMiddleware,
        readSession: input.readSession
    });
    const lifecycle = new BrowserRtcLifecycleRuntime({
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
        waitForRoomLane: async (room, laneId, options) => await wait.waitForRoomLane(room, laneId, options)
    });
    const diagnostics = new BrowserRtcDiagnosticsRuntime({
        readMiddleware: input.readMiddleware,
        readSession: input.readSession,
        readStatus: (options) => status.read(options)
    });
    const recovery = new BrowserRtcRecoveryRuntime({
        readMiddleware: input.readMiddleware,
        readStatus: () => status.read(),
        waitForLane: async (peerId, laneId, options) => await wait.waitForLane(peerId, laneId, options)
    });
    return { status, lifecycle, wait, rooms, diagnostics, recovery };
}

function createBrowserRtcOperations(
    runtimes: BrowserRtcRuntimes
): RallarRtcFacade {
    return {
        status: (options) => runtimes.status.read(options),
        roomStatus: (room, options) => runtimes.rooms.status(room, options),
        openRoom: async (room, options) => await runtimes.rooms.open(room, options),
        waitForRoom: async (room, options) => await runtimes.rooms.wait(room, options),
        onStatus: (listener, options = {}) => runtimes.lifecycle.onStatus(listener, options),
        onLifecycle: (listener, options = {}) => runtimes.lifecycle.onLifecycle(listener, options),
        waitForLane: async (peerId, laneId, options) => await runtimes.wait.waitForLane(peerId, laneId, options),
        waitForOpen: async (peerId, options = {}) =>
            await runtimes.wait.waitForLane(
                peerId,
                options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                options
            ),
        waitForRoomLane: async (room, laneId, options = {}) =>
            await runtimes.wait.waitForRoomLane(
                options.roomRef ?? room,
                laneId,
                options
            ),
        peer: (peerId, options) => runtimes.status.peer(peerId, options),
        knownPeerIds: () => runtimes.status.knownPeerIds(),
        activePeerIds: () => runtimes.status.activePeerIds(),
        peerIdsWithNoReconnectableLanes: () => runtimes.status.peerIdsWithNoReconnectableLanes(),
        readyPeerIds: (laneId) => runtimes.status.readyPeerIds(laneId),
        diagnostics: async (options) => await runtimes.diagnostics.read(options),
        restartIce: async (peerId) => await runtimes.recovery.restartIce(peerId),
        reconnectPeer: async (peerId, options) => await runtimes.recovery.reconnectPeer(peerId, options)
    };
}
