import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type { RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
import {
    readSelectedCandidatePairDiagnostics,
} from '@shared-web/browser/rtc-diagnostics/read-selected-candidate-pair-diagnostics.ts';
import { readOverlayAdoptionDiagnostics } from '@shared/repository/overlays-repository.ts';
import type {
    CreateRallarRtcFacadeOptions,
    RallarRoomTransportState,
    RallarRoomTransportStatus,
    RallarRtcCandidateDiagnostics,
    RallarRtcCandidatePairDiagnostics,
    RallarRtcDiagnostics,
    RallarRtcDiagnosticsOptions,
    RallarRtcLaneStatus,
    RallarRtcLifecycleKind,
    RallarRtcLifecycleListener,
    RallarRtcPeerConnectionStatus,
    RallarRtcPeerDiagnostics,
    RallarRtcPeerStatus,
    RallarRtcReconnectOptions,
    RallarRtcRecoveryResult,
    RallarRtcRecoveryStatus,
    RallarRtcRoomLaneWaitOptions,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcRoomMode,
    RallarRtcRoomTransportOptions,
    RallarRtcStatus,
    RallarRtcStatusListener,
    RallarRtcStatusOptions,
    RallarRtcStatusSubscriptionOptions,
    RallarRtcWaitForOpenOptions,
    RallarRtcWaitForOpenResult,
    RallarWaitForOpenStatus,
} from '@shared-web/browser/rallar-rtc-facade.ts';
import { notifyListener } from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import { normalizeWaitTimeoutMs } from '@shared-web/browser/rallar-runtime/wait.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    evaluateRallarReadinessExpectation,
    normalizeRallarReadinessExpectation,
    type RallarNormalizedReadinessExpectation,
    type RallarReadinessEvaluation,
} from '@shared-web/browser/readiness.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
    type QRtcPeerDto,
    type WebRtcPeerLaneOpenResult,
} from '@shared/services/WebRtcConnectionService.ts';
import type { QRtcClientCallbacks } from '@shared/webrtc/QRtcClientCallbacks.ts';
import type { RtcDataChannelHealth } from '@shared/webrtc/QRtcDataChannel.ts';

const RALLAR_RTC_STATUS_CALLBACK_ID = 'rallar:rtc:status';

type RallarRtcStatusSubscription = Readonly<{
    listener: RallarRtcStatusListener;
    options: RallarRtcStatusSubscriptionOptions;
}>;

type RallarRtcLifecycleSubscription = Readonly<{
    listener: RallarRtcLifecycleListener;
    options: RallarRtcStatusSubscriptionOptions;
}>;

export type CreateRallarRtcControllerOptions = Readonly<{
    readMiddleware(): ApiMiddleware | undefined;
    readSession(): AuthSession | undefined;
    readWsStatus(): RallarWsStatus;
    resolveRoomPeerIds(room: string | GroupRef): readonly string[];
    resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
    toRoomId(room: string | GroupRef | undefined): string | undefined;
    resolveRtcWaitTimeoutMs(timeoutMs?: number): number | undefined;
    resolveRtcConnectOnWait(connect?: boolean): boolean;
}>;

export type RallarRtcController = Readonly<{
    operations: CreateRallarRtcFacadeOptions;
    attach(ctx?: ApiMiddleware): void;
    connected(): void;
    detach(ctx?: ApiMiddleware): void;
    disconnected(): void;
}>;

export function createRallarRtcController(
    options: CreateRallarRtcControllerOptions,
): RallarRtcController {
    return new BrowserRallarRtcController(options);
}

class BrowserRallarRtcController implements RallarRtcController {
    private readonly rtcStatusListeners = new Set<RallarRtcStatusSubscription>();
    private readonly rtcLifecycleListeners =
        new Set<RallarRtcLifecycleSubscription>();

    private readonly options: CreateRallarRtcControllerOptions;

    constructor(options: CreateRallarRtcControllerOptions) {
        this.options = options;
    }

    readonly operations: CreateRallarRtcFacadeOptions = {
        status: (statusOptions) => this.toRtcStatus(statusOptions),
        roomStatus: (room, roomOptions) =>
            this.toRoomTransportStatus(room, roomOptions),
        openRoom: async (room, roomOptions) =>
            await this.openRtcRoom(room, roomOptions),
        waitForRoom: async (room, roomOptions) =>
            await this.waitForRtcRoom(room, roomOptions),
        onStatus: (listener, subscriptionOptions = {}) =>
            this.onRtcStatus(listener, subscriptionOptions),
        onLifecycle: (listener, subscriptionOptions = {}) =>
            this.onRtcLifecycle(listener, subscriptionOptions),
        waitForLane: async (peerId, laneId, waitOptions) =>
            await this.waitForRtcLaneOpen(peerId, laneId, waitOptions),
        waitForOpen: async (peerId, waitOptions = {}) =>
            await this.waitForRtcLaneOpen(
                peerId,
                waitOptions.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
                waitOptions,
            ),
        waitForRoomLane: async (room, laneId, waitOptions = {}) =>
            await this.waitForRtcRoomLaneOpen(
                waitOptions.roomRef ?? room,
                laneId,
                waitOptions,
            ),
        peer: (peerId, statusOptions) =>
            this.toRtcStatus(statusOptions).peers.find((peer) =>
                peer.peerId === peerId
            ),
        knownPeerIds: () => this.knownRtcPeerIds(),
        activePeerIds: () => this.activeRtcPeerIds(),
        peerIdsWithNoReconnectableLanes: () =>
            this.rtcPeerIdsWithNoReconnectableLanes(),
        readyPeerIds: (laneId) => this.readyRtcPeerIds(laneId),
        diagnostics: async (diagnosticOptions) =>
            await this.toRtcDiagnostics(diagnosticOptions),
        restartIce: async (peerId) => await this.restartRtcIce(peerId),
        reconnectPeer: async (peerId, reconnectOptions) =>
            await this.reconnectRtcPeer(peerId, reconnectOptions),
    };

    attach(ctx = this.readMiddleware()): void {
        this.registerRtcStatusCallbacks(ctx);
    }

    connected(): void {
        this.emitRtcLifecycle('connected');
    }

    detach(ctx = this.readMiddleware()): void {
        this.unregisterRtcStatusCallbacks(ctx);
    }

    disconnected(): void {
        this.emitRtcLifecycle('disconnected');
    }

    private onRtcStatus(
        listener: RallarRtcStatusListener,
        options: RallarRtcStatusSubscriptionOptions,
    ): RallarUnsubscribe {
        const subscription: RallarRtcStatusSubscription = {
            listener,
            options,
        };
        this.rtcStatusListeners.add(subscription);
        this.registerRtcStatusCallbacks();
        if (options.emitCurrent ?? true) {
            notifyListener(listener, this.toRtcStatus(options));
        }

        return () => {
            this.rtcStatusListeners.delete(subscription);
            this.unregisterRtcStatusCallbacksIfUnused();
        };
    }

    private onRtcLifecycle(
        listener: RallarRtcLifecycleListener,
        options: RallarRtcStatusSubscriptionOptions,
    ): RallarUnsubscribe {
        const subscription: RallarRtcLifecycleSubscription = {
            listener,
            options,
        };
        this.rtcLifecycleListeners.add(subscription);
        this.registerRtcStatusCallbacks();
        if (options.emitCurrent ?? true) {
            this.notifyRtcLifecycleSubscription(
                subscription,
                'snapshot',
            );
        }

        return () => {
            this.rtcLifecycleListeners.delete(subscription);
            this.unregisterRtcStatusCallbacksIfUnused();
        };
    }

    private knownRtcPeerIds(): readonly string[] {
        const ctx = this.readMiddleware();
        return ctx?.middleware.webRtcConnectionService.knownPeerIds() ?? [];
    }

    private activeRtcPeerIds(): readonly string[] {
        const ctx = this.readMiddleware();
        return ctx?.middleware.webRtcConnectionService.activePeerIds() ?? [];
    }

    private rtcPeerIdsWithNoReconnectableLanes(): readonly string[] {
        const ctx = this.readMiddleware();
        return ctx?.middleware.webRtcConnectionService
            .peerIdsWithNoReconnectableLanes() ?? [];
    }

    private readyRtcPeerIds(laneId?: string): readonly string[] {
        const ctx = this.readMiddleware();
        return ctx?.middleware.webRtcConnectionService.readyPeerIdsForLane(
            laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
        ) ?? [];
    }

    private toRtcStatus(
        options: RallarRtcStatusOptions = {},
    ): RallarRtcStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const ctx = this.readMiddleware();
        if (!ctx) {
            return {
                sessionId: this.options.readSession()?.sessionId,
                laneId,
                knownPeerIds: [],
                activePeerIds: [],
                peerIdsWithNoReconnectableLanes: [],
                readyPeerIds: [],
                peers: [],
            };
        }

        const service = ctx.middleware.webRtcConnectionService;
        const knownPeerIds = service.knownPeerIds();
        const activePeerIds = service.activePeerIds();
        const peerIdsWithNoReconnectableLanes = service
            .peerIdsWithNoReconnectableLanes();
        const readyPeerIds = service.readyPeerIdsForLane(laneId);
        const activePeerIdSet = new Set(activePeerIds);
        const peerIdsWithNoReconnectableLanesSet = new Set(
            peerIdsWithNoReconnectableLanes,
        );
        const readyPeerIdSet = new Set(readyPeerIds);

        return {
            sessionId: ctx.session.sessionId,
            laneId,
            knownPeerIds,
            activePeerIds,
            peerIdsWithNoReconnectableLanes,
            readyPeerIds,
            peers: knownPeerIds.map((peerId) =>
                this.toRtcPeerStatus(
                    peerId,
                    service.readPeer(peerId),
                    activePeerIdSet,
                    peerIdsWithNoReconnectableLanesSet,
                    readyPeerIdSet,
                )
            ),
        };
    }

    private toRtcPeerStatus(
        peerId: string,
        peer: QRtcPeerDto | undefined,
        activePeerIds: ReadonlySet<string>,
        peerIdsWithNoReconnectableLanes: ReadonlySet<string>,
        readyPeerIds: ReadonlySet<string>,
    ): RallarRtcPeerStatus {
        const lanes = peer
            ? Array.from(peer.channels.entries()).map(([laneId, channel]) =>
                toRtcLaneStatus(peerId, laneId, channel.readHealth())
            )
            : [];

        return {
            peerId,
            connection: toRtcConnectionStatus(peer),
            lanes,
            isActive: activePeerIds.has(peerId),
            hasNoReconnectableLanes: peerIdsWithNoReconnectableLanes.has(peerId),
            isRoutable: readyPeerIds.has(peerId),
            readyLaneIds: lanes
                .filter((lane) => lane.isOpen)
                .map((lane) => lane.laneId),
        };
    }

    private async toRtcDiagnostics(
        options: RallarRtcDiagnosticsOptions = {},
    ): Promise<RallarRtcDiagnostics> {
        const ctx = this.readMiddleware();
        const sessionId = ctx?.session.sessionId ??
            this.options.readSession()?.sessionId;
        if (!ctx) {
            return {
                sessionId,
                generatedAtEpochMs: Date.now(),
                peerCount: 0,
                connectedPeerCount: 0,
                relayPeerCount: 0,
                peers: [],
            };
        }

        const service = ctx.middleware.webRtcConnectionService;
        const peerIds = options.peerIds ?? service.knownPeerIds();
        const activePeerIds = new Set(service.activePeerIds());
        const noReconnectableLanePeerIds = new Set(
            service.peerIdsWithNoReconnectableLanes(),
        );
        const readyPeerIds = new Set(
            service.readyPeerIdsForLane(
                options.laneIds?.[0] ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID,
            ),
        );
        const peers = await Promise.all(
            [...new Set(peerIds)].map(async (peerId) => {
                const peer = service.readPeer(peerId);
                const status = this.toRtcPeerStatus(
                    peerId,
                    peer,
                    activePeerIds,
                    noReconnectableLanePeerIds,
                    readyPeerIds,
                );
                return await this.toRtcPeerDiagnostics(
                    status,
                    peer,
                    options,
                );
            }),
        );

        return {
            sessionId,
            generatedAtEpochMs: Date.now(),
            peerCount: peers.length,
            connectedPeerCount: peers.filter((peer) =>
                peer.connection.connectionState === 'connected'
            ).length,
            relayPeerCount: peers.filter((peer) => peer.usesRelay).length,
            peers,
            groupManager: ctx.middleware.webRtcGroupManager.readDiagnostics?.(),
            overlayAdoption: readOverlayAdoptionDiagnostics(),
        };
    }

    private async toRtcPeerDiagnostics(
        status: RallarRtcPeerStatus,
        peer: QRtcPeerDto | undefined,
        options: RallarRtcDiagnosticsOptions,
    ): Promise<RallarRtcPeerDiagnostics> {
        const laneIds = options.laneIds
            ? new Set(options.laneIds)
            : undefined;
        const lanes = laneIds
            ? status.lanes.filter((lane) => laneIds.has(lane.laneId))
            : status.lanes;
        const connectionDiagnostics = peer?.connection.readDiagnostics?.();

        try {
            const selectedCandidatePair = await readSelectedCandidatePairDiagnostics(
                peer?.connection.status.pc,
            );
            const diagnostics = {
                peerId: status.peerId,
                connection: status.connection,
                lanes,
                selectedCandidatePair,
                usesRelay: selectedCandidatePair?.usesRelay ?? false,
                statsAvailable: selectedCandidatePair !== undefined,
            };
            return connectionDiagnostics === undefined
                ? diagnostics
                : { ...diagnostics, connectionDiagnostics };
        } catch (error) {
            const diagnostics = {
                peerId: status.peerId,
                connection: status.connection,
                lanes,
                usesRelay: false,
                statsAvailable: false,
                statsError: toErrorMessage(error),
            };
            return connectionDiagnostics === undefined
                ? diagnostics
                : { ...diagnostics, connectionDiagnostics };
        }
    }

    private async restartRtcIce(
        peerId: string,
    ): Promise<RallarRtcRecoveryResult> {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'not-connected',
                'Rallar is not connected.',
            );
        }

        const peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
        if (!peer) {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'no-peer',
                `RTC peer ${peerId} is not known.`,
            );
        }

        const pc = peer.connection.status.pc;
        if (!pc || typeof pc.restartIce !== 'function') {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'unsupported',
                `RTC peer ${peerId} does not expose restartIce().`,
            );
        }

        try {
            pc.restartIce();
            return this.toRtcRecoveryResult(peerId, 'restart-ice', 'restarted');
        } catch (error) {
            return this.toRtcRecoveryResult(
                peerId,
                'restart-ice',
                'failed',
                toErrorMessage(error),
            );
        }
    }

    private async reconnectRtcPeer(
        peerId: string,
        options: RallarRtcReconnectOptions = {},
    ): Promise<RallarRtcRecoveryResult> {
        const ctx = this.readMiddleware();
        if (!ctx) {
            return this.toRtcRecoveryResult(
                peerId,
                'reconnect',
                'not-connected',
                'Rallar is not connected.',
            );
        }

        try {
            ctx.middleware.webRtcConnectionService.disconnectPeer(peerId);
            const laneId = options.laneId;
            if (laneId) {
                const result = await this.waitForRtcLaneOpen(
                    peerId,
                    laneId,
                    {
                        ...options,
                        connect: true,
                    },
                );
                return this.toRtcRecoveryResult(
                    peerId,
                    'reconnect',
                    result.status === 'open' ? 'started' : 'failed',
                    result.reason,
                );
            }

            const started = ctx.middleware.webRtcConnectionService
                .ensurePeerConnectionStarted(peerId);
            if (started.left) {
                return this.toRtcRecoveryResult(
                    peerId,
                    'reconnect',
                    started.left.kind === 'self' ? 'failed' : 'failed',
                    started.left.kind,
                );
            }

            return this.toRtcRecoveryResult(peerId, 'reconnect', 'started');
        } catch (error) {
            return this.toRtcRecoveryResult(
                peerId,
                'reconnect',
                'failed',
                toErrorMessage(error),
            );
        }
    }

    private toRtcRecoveryResult(
        peerId: string,
        action: RallarRtcRecoveryResult['action'],
        status: RallarRtcRecoveryStatus,
        reason?: string,
    ): RallarRtcRecoveryResult {
        return {
            peerId,
            action,
            status,
            rtcStatus: this.toRtcStatus(),
            reason,
        };
    }

    private async waitForRtcLaneOpen(
        peerId: string,
        laneId: string,
        options: RallarRtcWaitForOpenOptions = {},
    ): Promise<RallarRtcWaitForOpenResult> {
        const ctx = this.readMiddleware();
        if (options.signal?.aborted) {
            return this.toRtcWaitForOpenResult('aborted', peerId, laneId);
        }

        if (!ctx) {
            return this.toRtcWaitForOpenResult('not-connected', peerId, laneId);
        }

        if (this.resolveRtcConnectOnWait(options.connect)) {
            return await this.waitForRtcLaneOpenWithConnect(
                ctx,
                peerId,
                laneId,
                options,
            );
        }

        let peer = ctx.middleware.webRtcConnectionService.readPeer(peerId);
        if (!peer) {
            return this.toRtcWaitForOpenResult('no-peer', peerId, laneId);
        }

        const channel = peer.channels.get(laneId);
        if (!channel) {
            return this.toRtcWaitForOpenResult('no-lane', peerId, laneId);
        }

        const initialHealth = channel.readHealth();
        if (initialHealth.readyState === 'open') {
            return this.toRtcWaitForOpenResult('open', peerId, laneId);
        }

        if (isClosedRtcLaneHealth(initialHealth)) {
            return this.toRtcWaitForOpenResult('closed', peerId, laneId);
        }

        const timeoutMs = normalizeWaitTimeoutMs(
            this.resolveRtcWaitTimeoutMs(options.timeoutMs),
        );
        if (timeoutMs <= 0) {
            return this.toRtcWaitForOpenResult('timeout', peerId, laneId);
        }

        const opened = await waitForRtcChannelOpenOrAbort(
            channel.waitUntilOpen(timeoutMs),
            options.signal,
        );
        if (opened === 'aborted') {
            return this.toRtcWaitForOpenResult('aborted', peerId, laneId);
        }

        if (opened) {
            return this.toRtcWaitForOpenResult('open', peerId, laneId);
        }

        return this.toRtcWaitForOpenResult(
            isClosedRtcLaneHealth(channel.readHealth()) ? 'closed' : 'timeout',
            peerId,
            laneId,
        );
    }

    private async waitForRtcRoomLaneOpen(
        room: string | GroupRef,
        laneId: string,
        options: RallarRtcRoomLaneWaitOptions = {},
    ): Promise<RallarRtcRoomLaneWaitResult> {
        const roomId = typeof room === 'string' ? room : room.groupId;
        const peerIds = this.resolveRoomPeerIds(options.roomRef ?? room);
        const expectation = normalizeRallarReadinessExpectation(
            options.expect ?? { exact: peerIds.length },
        );
        if (peerIds.length === 0) {
            return this.toRtcRoomLaneWaitResult(
                roomId,
                laneId,
                [],
                [],
                expectation,
                options.expect !== undefined,
            );
        }

        const results = await Promise.all(
            peerIds.map((peerId) =>
                this.waitForRtcLaneOpen(
                    peerId,
                    laneId,
                    options,
                )
            ),
        );
        const ready = results.filter((result) => result.status === 'open');
        const notReady = results.filter((result) => result.status !== 'open');

        return this.toRtcRoomLaneWaitResult(
            roomId,
            laneId,
            ready,
            notReady,
            expectation,
            options.expect !== undefined,
        );
    }

    private async openRtcRoom(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
    ): Promise<RallarRoomTransportStatus> {
        const mode = options.mode ?? 'lazy';
        if (mode === 'off' || mode === 'lazy') {
            return this.toRoomTransportStatus(room, {
                ...options,
                mode,
            });
        }

        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.waitForRtcRoomLaneOpen(
            room,
            laneId,
            {
                ...options,
                connect: true,
            },
        );

        return this.toRoomTransportStatus(room, {
            ...options,
            mode,
            laneId,
        }, readiness);
    }

    private async waitForRtcRoom(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
    ): Promise<RallarRoomTransportStatus> {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const readiness = await this.waitForRtcRoomLaneOpen(
            room,
            laneId,
            {
                ...options,
                connect: options.connect ?? true,
            },
        );

        return this.toRoomTransportStatus(room, {
            ...options,
            laneId,
        }, readiness);
    }

    private toRoomTransportStatus(
        room: string | GroupRef,
        options: RallarRtcRoomTransportOptions = {},
        readiness?: RallarRtcRoomLaneWaitResult,
    ): RallarRoomTransportStatus {
        const laneId = options.laneId ?? DEFAULT_RTC_DATA_CHANNEL_LANE_ID;
        const mode = options.mode ?? 'lazy';
        const roomRef = this.resolveRoomRef(room);
        const roomId = this.toRoomId(room);
        const desiredPeerIds = this.resolveRoomPeerIds(roomRef ?? room);
        const desiredPeerIdSet = new Set(desiredPeerIds);
        const rtcStatus = this.toRtcStatus({ laneId });
        const knownPeerIds = rtcStatus.knownPeerIds.filter((peerId) =>
            desiredPeerIdSet.has(peerId)
        );
        const activePeerIds = rtcStatus.activePeerIds.filter((peerId) =>
            desiredPeerIdSet.has(peerId)
        );
        const readyPeerIds = rtcStatus.readyPeerIds.filter((peerId) =>
            desiredPeerIdSet.has(peerId)
        );
        const failedPeerIds = rtcStatus.peerIdsWithNoReconnectableLanes.filter(
            (peerId) => desiredPeerIdSet.has(peerId),
        );
        const minReadyPeers = Math.max(
            0,
            options.minReadyPeers ?? desiredPeerIds.length,
        );
        const state = toRoomTransportState({
            mode,
            desiredPeerCount: desiredPeerIds.length,
            knownPeerCount: knownPeerIds.length,
            activePeerCount: activePeerIds.length,
            readyPeerCount: readyPeerIds.length,
            failedPeerCount: failedPeerIds.length,
            minReadyPeers,
            waitStatus: readiness?.status,
        });

        return {
            roomRef,
            roomId,
            ws: this.ws.status(),
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
                reason: toRoomTransportReason(state, readiness),
            },
        };
    }

    private async waitForRtcLaneOpenWithConnect(
        ctx: ApiMiddleware,
        peerId: string,
        laneId: string,
        options: RallarRtcWaitForOpenOptions,
    ): Promise<RallarRtcWaitForOpenResult> {
        try {
            const result = await ctx.middleware.webRtcConnectionService
                .ensurePeerLaneOpen(
                    peerId,
                    laneId,
                    {
                        timeoutMs: normalizeWaitTimeoutMs(
                            this.resolveRtcWaitTimeoutMs(options.timeoutMs),
                        ),
                        signal: options.signal,
                    },
                );

            return this.toRtcWaitForOpenResultFromPeerLaneOpen(result);
        } catch (error) {
            return this.toRtcWaitForOpenResult(
                'failed',
                peerId,
                laneId,
                toErrorMessage(error),
            );
        }
    }

    private toRtcWaitForOpenResultFromPeerLaneOpen(
        result: WebRtcPeerLaneOpenResult,
    ): RallarRtcWaitForOpenResult {
        return this.toRtcWaitForOpenResult(
            toRallarWaitForOpenStatus(result.status),
            result.peerId,
            result.laneId,
            toPeerLaneOpenReason(result),
        );
    }

    private toRtcRoomLaneWaitResult(
        roomId: string,
        laneId: string,
        ready: readonly RallarRtcWaitForOpenResult[],
        notReady: readonly RallarRtcWaitForOpenResult[],
        expectation: RallarNormalizedReadinessExpectation,
        preferUnsatisfiedTerminalStatus: boolean,
    ): RallarRtcRoomLaneWaitResult {
        const readyPeerIds = uniquePeerIds(ready.map((result) => result.peerId));
        const notReadyPeerIds = uniquePeerIds(notReady.map((result) => result.peerId));
        const evaluation = evaluateRallarReadinessExpectation(
            readyPeerIds,
            expectation,
        );
        const waitStatus = toRtcRoomLaneWaitStatus(ready, notReady);
        return {
            transport: 'rtc',
            roomId,
            laneId,
            status: toExpectationAwareRtcRoomLaneWaitStatus(
                evaluation,
                waitStatus,
                readyPeerIds,
                notReady,
                preferUnsatisfiedTerminalStatus,
            ),
            rtcStatus: this.toRtcStatus({ laneId }),
            ready,
            notReady,
            readyPeerIds,
            notReadyPeerIds,
            missingPeerIds: evaluation.missingSessionIds,
            extraPeerIds: evaluation.extraSessionIds,
            observedCount: evaluation.observedCount,
            expectedCount: evaluation.expectedCount,
        };
    }

    private toRtcWaitForOpenResult(
        status: RallarWaitForOpenStatus,
        peerId: string,
        laneId: string,
        reason?: string,
    ): RallarRtcWaitForOpenResult {
        const rtcStatus = this.toRtcStatus({ laneId });
        const peer = rtcStatus.peers.find((candidate) =>
            candidate.peerId === peerId
        );
        const lane = peer?.lanes.find((candidate) =>
            candidate.laneId === laneId
        );
        return {
            transport: 'rtc',
            status,
            peerId,
            laneId,
            rtcStatus,
            peer,
            lane,
            reason,
        };
    }

    private registerRtcStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.readMiddleware(),
    ): void {
        if (!ctx || !this.hasRtcStatusSubscriptions()) {
            return;
        }

        const service = ctx.middleware.webRtcConnectionService;
        service.onRtcPeerLifecycleDo(
            RALLAR_RTC_STATUS_CALLBACK_ID,
            {
                onCreated: (peer) => {
                    this.registerRtcStatusCallbacksForPeer(peer);
                    this.emitRtcLifecycle('peer-created', {
                        peerId: peer.peerId,
                    });
                },
                onDeleted: (peer) => {
                    this.unregisterRtcStatusCallbacksForPeer(peer);
                    this.emitRtcLifecycleSoon('peer-deleted', {
                        peerId: peer.peerId,
                    });
                },
                onConnectTimeout: (peer) => {
                    this.emitRtcLifecycle('peer-timeout', {
                        peerId: peer.peerId,
                    });
                },
            },
        );

        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.registerRtcStatusCallbacksForPeer(peer);
            }
        }
    }

    private registerRtcStatusCallbacksForPeer(peer: QRtcPeerDto): void {
        for (const [laneId, channel] of peer.channels.entries()) {
            channel.onRtcCallbacksDo(
                RALLAR_RTC_STATUS_CALLBACK_ID,
                this.toRtcLaneLifecycleCallbacks(peer.peerId, laneId),
            );
        }
    }

    private toRtcLaneLifecycleCallbacks(
        peerId: string,
        laneId: string,
    ): QRtcClientCallbacks {
        return {
            onOpen: async () => {
                this.emitRtcLifecycle('lane-open', { peerId, laneId });
            },
            onClose: async () => {
                this.emitRtcLifecycle('lane-close', { peerId, laneId });
            },
            onError: async () => {
                this.emitRtcLifecycle('lane-error', { peerId, laneId });
            },
        };
    }

    private unregisterRtcStatusCallbacksIfUnused(): void {
        if (this.hasRtcStatusSubscriptions()) {
            return;
        }

        this.unregisterRtcStatusCallbacks();
    }

    private unregisterRtcStatusCallbacks(
        ctx: ApiMiddleware | undefined = this.readMiddleware(),
    ): void {
        if (!ctx) {
            return;
        }

        const service = ctx.middleware.webRtcConnectionService;
        service.removeRtcPeerLifecycleById(RALLAR_RTC_STATUS_CALLBACK_ID);
        for (const peerId of service.knownPeerIds()) {
            const peer = service.readPeer(peerId);
            if (peer) {
                this.unregisterRtcStatusCallbacksForPeer(peer);
            }
        }
    }

    private unregisterRtcStatusCallbacksForPeer(peer: QRtcPeerDto): void {
        for (const channel of peer.channels.values()) {
            channel.removeRtcCallbackById(RALLAR_RTC_STATUS_CALLBACK_ID);
        }
    }

    private hasRtcStatusSubscriptions(): boolean {
        return this.rtcStatusListeners.size > 0 ||
            this.rtcLifecycleListeners.size > 0;
    }

    private emitRtcLifecycleSoon(
        kind: RallarRtcLifecycleKind,
        input: Readonly<{
            peerId?: string;
            laneId?: string;
        }> = {},
    ): void {
        queueMicrotask(() => this.emitRtcLifecycle(kind, input));
    }

    private emitRtcLifecycle(
        kind: RallarRtcLifecycleKind,
        input: Readonly<{
            peerId?: string;
            laneId?: string;
        }> = {},
    ): void {
        this.emitRtcStatus();
        for (const subscription of this.rtcLifecycleListeners) {
            this.notifyRtcLifecycleSubscription(subscription, kind, input);
        }
    }

    private emitRtcStatus(): void {
        for (const subscription of this.rtcStatusListeners) {
            notifyListener(
                subscription.listener,
                this.toRtcStatus(subscription.options),
            );
        }
    }

    private notifyRtcLifecycleSubscription(
        subscription: RallarRtcLifecycleSubscription,
        kind: RallarRtcLifecycleKind,
        input: Readonly<{
            peerId?: string;
            laneId?: string;
        }> = {},
    ): void {
        const status = this.toRtcStatus(subscription.options);
        const peer = input.peerId
            ? status.peers.find((candidate) => candidate.peerId === input.peerId)
            : undefined;
        const lane = input.laneId
            ? peer?.lanes.find((candidate) => candidate.laneId === input.laneId)
            : undefined;

        notifyListener(subscription.listener, {
            kind,
            atEpochMs: Date.now(),
            status,
            peerId: input.peerId,
            laneId: input.laneId,
            peer,
            lane,
        });
    }

    private readMiddleware(): ApiMiddleware | undefined {
        return this.options.readMiddleware();
    }

    private resolveRoomPeerIds(room: string | GroupRef): readonly string[] {
        return this.options.resolveRoomPeerIds(room);
    }

    private resolveRoomRef(
        room: string | GroupRef | undefined,
    ): GroupRef | undefined {
        return this.options.resolveRoomRef(room);
    }

    private toRoomId(
        room: string | GroupRef | undefined,
    ): string | undefined {
        return this.options.toRoomId(room);
    }

    private resolveRtcWaitTimeoutMs(timeoutMs?: number): number | undefined {
        return this.options.resolveRtcWaitTimeoutMs(timeoutMs);
    }

    private resolveRtcConnectOnWait(connect?: boolean): boolean {
        return this.options.resolveRtcConnectOnWait(connect);
    }

    private get ws(): Readonly<{ status(): RallarWsStatus }> {
        return { status: this.options.readWsStatus };
    }
}

function toRtcConnectionStatus(
    peer: QRtcPeerDto | undefined,
): RallarRtcPeerConnectionStatus {
    const status = peer?.connection.status;
    const pc = status?.pc;

    return {
        state: status?.state ? String(status.state) : undefined,
        connectionState: pc?.connectionState,
        iceConnectionState: pc?.iceConnectionState,
        iceGatheringState: pc?.iceGatheringState,
        signalingState: pc?.signalingState,
        hasLocalDescription: pc?.localDescription !== null &&
            pc?.localDescription !== undefined,
        hasRemoteDescription: pc?.remoteDescription !== null &&
            pc?.remoteDescription !== undefined,
        canTrickleIceCandidates: pc?.canTrickleIceCandidates,
        reconnectAttempts: status?.reconnectAttempts ?? 0,
        reconnecting: status?.reconnectTimer !== undefined,
        disconnectPending: status?.disconnectTimer !== undefined,
        makingOffer: status?.makingOffer ?? false,
        ignoreOffer: status?.ignoreOffer ?? false,
        iceCandidateQueueSize: status?.iceCandidateQueue.length ?? 0,
        localStreamId: status?.localStream?.id,
        remoteStreamIds: Array.from(status?.remoteStreams.keys() ?? []),
    };
}

function toRtcLaneStatus(
    peerId: string,
    laneId: string,
    channel: RtcDataChannelHealth | undefined,
): RallarRtcLaneStatus {
    return {
        peerId,
        laneId,
        channel,
        isOpen: channel?.readyState === 'open' || channel?.state === 'Open',
        isReconnectable: isReconnectableRtcLane(channel),
    };
}

function isReconnectableRtcLane(
    channel: RtcDataChannelHealth | undefined,
): boolean {
    return channel?.state === 'Idle' ||
        channel?.state === 'Closed' ||
        channel?.state === 'Failed';
}

function isClosedRtcLaneHealth(
    channel: RtcDataChannelHealth | undefined,
): boolean {
    return channel?.readyState === 'closing' ||
        channel?.readyState === 'closed' ||
        channel?.state === 'Closed' ||
        channel?.state === 'Failed';
}

function waitForRtcChannelOpenOrAbort(
    waitUntilOpen: Promise<boolean>,
    signal?: AbortSignal,
): Promise<boolean | 'aborted'> {
    if (!signal) {
        return waitUntilOpen;
    }

    if (signal.aborted) {
        return Promise.resolve('aborted');
    }

    return new Promise<boolean | 'aborted'>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            resolve('aborted');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waitUntilOpen
            .then((opened) => {
                signal.removeEventListener('abort', onAbort);
                resolve(opened);
            })
            .catch((error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
    });
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toRallarWaitForOpenStatus(
    status: WebRtcPeerLaneOpenResult['status'],
): RallarWaitForOpenStatus {
    switch (status) {
        case 'open':
        case 'timeout':
        case 'aborted':
        case 'no-peer':
        case 'no-lane':
        case 'closed':
            return status;
        case 'exhausted':
        case 'self':
        case 'connect-failed':
        case 'failed':
            return 'failed';
    }
}

function toRtcRoomLaneWaitStatus(
    ready: readonly RallarRtcWaitForOpenResult[],
    notReady: readonly RallarRtcWaitForOpenResult[],
): RallarRtcRoomLaneWaitStatus {
    if (ready.length === 0 && notReady.length === 0) {
        return 'empty';
    }

    if (notReady.length === 0) {
        return 'open';
    }

    if (ready.length > 0) {
        return 'partial';
    }

    if (notReady.every((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }

    if (notReady.every((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }

    if (notReady.every((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }

    if (notReady.every((peer) => peer.status === 'failed')) {
        return 'failed';
    }

    return 'not-ready';
}

function toExpectationAwareRtcRoomLaneWaitStatus(
    evaluation: RallarReadinessEvaluation,
    waitStatus: RallarRtcRoomLaneWaitStatus,
    readyPeerIds: readonly string[],
    notReady: readonly RallarRtcWaitForOpenResult[],
    preferUnsatisfiedTerminalStatus: boolean,
): RallarRtcRoomLaneWaitStatus {
    if (evaluation.status === 'over-capacity') {
        return 'over-capacity';
    }

    if (evaluation.status === 'empty' && evaluation.expectedCount === 0) {
        return 'empty';
    }

    if (evaluation.status === 'ready') {
        return waitStatus === 'open'
            ? 'open'
            : readyPeerIds.length > 0
                ? 'partial'
                : 'empty';
    }

    if (!preferUnsatisfiedTerminalStatus) {
        return waitStatus;
    }

    if (notReady.some((peer) => peer.status === 'failed')) {
        return 'failed';
    }
    if (notReady.some((peer) => peer.status === 'aborted')) {
        return 'aborted';
    }
    if (notReady.some((peer) => peer.status === 'timeout')) {
        return 'timeout';
    }
    if (notReady.some((peer) => peer.status === 'not-connected')) {
        return 'not-connected';
    }

    return waitStatus;
}

function toRoomTransportState(
    input: Readonly<{
        mode: RallarRtcRoomMode;
        desiredPeerCount: number;
        knownPeerCount: number;
        activePeerCount: number;
        readyPeerCount: number;
        failedPeerCount: number;
        minReadyPeers: number;
        waitStatus?: RallarRtcRoomLaneWaitStatus;
    }>,
): RallarRoomTransportState {
    if (input.mode === 'off') {
        return 'off';
    }

    if (input.desiredPeerCount === 0) {
        return 'open';
    }

    if (input.readyPeerCount === input.desiredPeerCount) {
        return 'open';
    }

    if (
        input.minReadyPeers > 0 &&
        input.readyPeerCount >= input.minReadyPeers
    ) {
        return 'partial';
    }

    if (
        input.waitStatus === 'failed' ||
        input.waitStatus === 'timeout' ||
        input.failedPeerCount >= input.desiredPeerCount
    ) {
        return input.readyPeerCount > 0 ? 'degraded' : 'failed';
    }

    if (input.failedPeerCount > 0 && input.readyPeerCount > 0) {
        return 'degraded';
    }

    if (input.knownPeerCount > 0 || input.activePeerCount > 0) {
        return 'connecting';
    }

    return 'idle';
}

function toRoomTransportReason(
    state: RallarRoomTransportState,
    readiness?: RallarRtcRoomLaneWaitResult,
): string | undefined {
    if (readiness?.status === 'empty') {
        return 'Room has no RTC peer targets.';
    }

    if (
        readiness?.status === 'timeout' ||
        readiness?.status === 'failed' ||
        readiness?.status === 'aborted' ||
        readiness?.status === 'not-connected'
    ) {
        return `Room RTC wait ended with ${readiness.status}.`;
    }

    if (state === 'idle') {
        return 'Room RTC has not started connecting yet.';
    }

    if (state === 'partial') {
        return 'Room RTC is partially ready.';
    }

    if (state === 'degraded') {
        return 'Room RTC is degraded.';
    }

    return undefined;
}

function toPeerLaneOpenReason(
    result: WebRtcPeerLaneOpenResult,
): string | undefined {
    if (result.status === 'open' || !result.error) {
        return undefined;
    }

    const cause = (result.error as Error & { cause?: unknown }).cause;
    return cause !== undefined
        ? toErrorMessage(cause)
        : result.error.message;
}

function uniquePeerIds(peerIds: readonly string[]): readonly string[] {
    return [...new Set(peerIds)];
}
