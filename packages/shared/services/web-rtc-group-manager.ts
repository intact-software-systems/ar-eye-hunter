import type { PeerId } from '../api/api-config.ts';
import {
    readActiveClientSessionIds,
    type AnyGroupPresence
} from '../api/group-client-views.ts';
import type { GroupRef } from '../api/group-types.ts';
import { toError } from '../resilience/to-error.ts';
import {
    isRtcRttCanonicalReporter,
    normalizeRttReportingDegreeLimit,
    selectRttReportingPeers
} from '../rtc/rtt-reporting-policy.ts';
import type { WebRtcGroupPeerLedger } from './group-dial/web-rtc-group-peer-ledger.ts';
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';
import type { WebRtcGroupService } from './web-rtc-group-service.ts';
import {
    emptyGroupReconcileDiagnostics,
    type WebRtcGroupManagerDeleteOptions,
    type WebRtcGroupManagerDiagnostics,
    type WebRtcGroupManagerOptions,
    type WebRtcGroupManagerState,
    type WebRtcRttReportingPeerOptions
} from './webrtc-group-manager-contracts.ts';
import {
    computeOverlayRttReportingDegreeLimit,
    computeServerDesiredPeerIds,
    readOverlayForGroup
} from './webrtc-group-overlay-reading.ts';
import { computeOutboundDialPlan } from './webrtc-outbound-dial-plan.ts';
import {
    disconnectAbsentPeerDials,
    disconnectUnansweredRetainedDials,
    WebRtcOutboundDialing,
    type OutboundDialsStarted
} from './webrtc-outbound-dialing.ts';

export type {
    WebRtcGroupManagerDeleteOptions,
    WebRtcGroupManagerDiagnostics,
    WebRtcGroupManagerOptions,
    WebRtcGroupManagerState,
    WebRtcRttReportingPeerOptions
} from './webrtc-group-manager-contracts.ts';

interface RttReportingGroupPair {
    readonly group: WebRtcGroupService;
    readonly peerId: PeerId;
    readonly activePeerSessionIds: readonly PeerId[];
    readonly degreeLimit: number;
}

export class WebRtcGroupManager {
    private static readonly PEER_RECOVERY_CALLBACK_ID = 'webrtc-group-manager:peer-recovery';

    private reconcileInFlight: Promise<void> | undefined;
    private reconcileRequested = false;
    private reconcilePassRunning = false;
    private reconcileWakesActive = false;
    private scheduledWake: Promise<void> | undefined;
    private retainedExpiryWake: ReturnType<typeof setTimeout> | undefined;
    private readonly diagnostics = emptyGroupReconcileDiagnostics();

    public readonly rtcQBox: WebRtcConnectionService;
    private readonly ledger: WebRtcGroupPeerLedger;
    public readonly options: WebRtcGroupManagerOptions;

    constructor(
        rtcQBox: WebRtcConnectionService,
        ledger: WebRtcGroupPeerLedger,
        options: WebRtcGroupManagerOptions
    ) {
        this.rtcQBox = rtcQBox;
        this.ledger = ledger;
        this.options = options;
    }

    /**
     * Setup completion frees an in-flight slot; desired peers and lanes recover
     * after closure, and retained peers expire without an external event. The
     * composition root starts these wakes once the service and manager exist;
     * shutdown stops them before tearing peers down so removal cannot dial them
     * back.
     */
    startReconcileWakes(): void {
        this.reconcileWakesActive = true;
        this.rtcQBox.onRtcPeerLifecycleDo(WebRtcGroupManager.PEER_RECOVERY_CALLBACK_ID, {
            onCreated: (peer) => this.observePeerLanes(peer),
            onDeleted: (peer) => {
                this.stopObservingPeerLanes(peer);
                this.wakeAfterPeerChanged(peer.peerId);
            },
            onEstablished: () => this.wakeAfterPeerChanged()
        });
        for (const peerId of this.rtcQBox.knownPeerIds()) {
            const peer = this.rtcQBox.readPeer(peerId);
            if (peer) {
                this.observePeerLanes(peer);
            }
        }
        this.startRetainedExpiryWake();
    }

    stopReconcileWakes(): void {
        this.reconcileWakesActive = false;
        this.stopRetainedExpiryWake();
        this.rtcQBox.removeRtcPeerLifecycleById(WebRtcGroupManager.PEER_RECOVERY_CALLBACK_ID);
        for (const peerId of this.rtcQBox.knownPeerIds()) {
            const peer = this.rtcQBox.readPeer(peerId);
            if (peer) {
                this.stopObservingPeerLanes(peer);
            }
        }
        // A wake already on the microtask queue observes the inactive latch and stands down.
        this.ledger.setWaitingDialCount(0);
    }

    private observePeerLanes(peer: WebRtcConnectionService.Peer): void {
        for (const channel of peer.channels.values()) {
            channel.onRtcCallbacksDo(WebRtcGroupManager.PEER_RECOVERY_CALLBACK_ID, {
                onClose: async () => {
                    if (this.rtcQBox.readPeer(peer.peerId) === peer && channel.isReadyToConnect()) {
                        this.wakeAfterPeerChanged(peer.peerId);
                    }
                }
            });
        }
    }

    private stopObservingPeerLanes(peer: WebRtcConnectionService.Peer): void {
        for (const channel of peer.channels.values()) {
            channel.removeRtcCallbackById(WebRtcGroupManager.PEER_RECOVERY_CALLBACK_ID);
        }
    }

    /** Settles after reconciliation requested by a peer lifecycle event or an in-flight update. */
    whenReconciled(): Promise<void> {
        return this.scheduledWake ?? this.reconcileInFlight ?? Promise.resolve();
    }

    readDiagnostics(): WebRtcGroupManagerDiagnostics {
        return { ...this.diagnostics, ...this.ledger.readDiagnostics() };
    }

    resetDiagnostics(): void {
        Object.assign(this.diagnostics, emptyGroupReconcileDiagnostics());
        this.ledger.resetDiagnostics();
    }

    has(group: GroupRef): boolean {
        return this.ledger.has(group);
    }

    async delete(
        group: GroupRef,
        options: WebRtcGroupManagerDeleteOptions = {}
    ): Promise<boolean> {
        if (!this.ledger.deleteGroup(group, options, this.rtcQBox)) {
            return false;
        }

        await this.reconcileAllGroups();
        return true;
    }

    async clear(): Promise<void> {
        this.ledger.clear();
        await this.reconcileAllGroups();
    }

    state(): WebRtcGroupManagerState {
        const peerOwners = this.ledger.peerOwners();
        const desiredPeerIds = Array.from(peerOwners.keys());
        const onlinePeerIdSet = this.onlinePeerIds();
        const onlinePeerIds = Array.from(onlinePeerIdSet);
        const onlineDesiredPeerIds = desiredPeerIds.filter((peerId) => onlinePeerIdSet.has(peerId));
        const groupPresentDesiredPeerIds = this.ledger.readPeerOwnership().dialAllowedPeerIds;
        const connectablePeerIds = desiredPeerIds.filter((peerId) => groupPresentDesiredPeerIds.has(peerId));
        const peerIdsWithNoReconnectableLanes = this.rtcQBox
            .peerIdsWithNoReconnectableLanes();

        return {
            groupIds: this.ledger.groupIds(),
            desiredPeerIds,
            onlinePeerIds,
            onlineDesiredPeerIds,
            connectablePeerIds,
            peerIdsWithNoReconnectableLanes,
            peerOwners
        };
    }

    rttReportingPeerIds(
        options: WebRtcRttReportingPeerOptions = {}
    ): readonly PeerId[] {
        const degreeLimit = normalizeRttReportingDegreeLimit(
            options.degreeLimit,
            computeOverlayRttReportingDegreeLimit(
                this.ledger.plannedOverlayCache,
                this.ledger.groups().map((group) => group.groupRef)
            )
        );
        return this.rttReportingCandidatePeerIds(degreeLimit)
            .slice(0, degreeLimit);
    }

    async acceptGroupUpdate(
        snapshot: AnyGroupPresence
    ): Promise<WebRtcGroupService> {
        const group = this.ledger.getOrCreate(snapshot.group);
        await group.acceptGroupUpdate(snapshot);
        await this.reconcileAllGroups();
        return group;
    }

    async refreshAllGroups(): Promise<void> {
        await this.ledger.refreshGroups();

        await this.reconcileAllGroups();
    }

    async ensureAllGroupsConnected(): Promise<void> {
        await this.reconcileAllGroups();
    }

    /**
     * A reconcile request arriving while a run is in flight is never dropped:
     * the flag survives the run, and either the drain loop or the awaiting
     * caller re-runs against the newest state. Without this the single-flight
     * guard would silently lose the second trigger's mutations.
     */
    private async reconcileAllGroups(): Promise<void> {
        this.reconcileRequested = true;
        if (this.reconcileInFlight) {
            this.diagnostics.reconcileAwaitedInFlightCount += 1;
            await this.reconcileInFlight;
            if (!this.reconcileRequested) {
                return;
            }
            if (this.reconcileInFlight) {
                await this.reconcileInFlight;
                return;
            }
        }

        const run = this.drainReconcileRequests();
        this.reconcileInFlight = run;
        try {
            await run;
        }
        finally {
            if (this.reconcileInFlight === run) {
                this.reconcileInFlight = undefined;
            }
        }
    }

    private wakeAfterPeerChanged(changedPeerId?: PeerId): void {
        // A pass runs synchronously, so a change observed while it runs is one
        // the pass caused itself and already accounted for.
        const changedDesiredPeer = changedPeerId !== undefined &&
            this.ledger.isPeerDialAllowedByAnyGroup(changedPeerId);
        if (
            !this.reconcileWakesActive ||
            (this.ledger.getWaitingDialCount() === 0 && !changedDesiredPeer) ||
            this.reconcilePassRunning ||
            this.scheduledWake
        ) {
            return;
        }
        // Deferred past the notification that raised it, so every observer sees
        // the change before the dials it releases.
        this.scheduledWake = Promise.resolve()
            .then(() => {
                this.scheduledWake = undefined;
                if (!this.reconcileWakesActive) {
                    return;
                }
                return this.reconcileAllGroups();
            })
            .catch((caught) => {
                console.error('Failed to reconcile groups after a peer changed', toError(caught));
            });
    }

    private async drainReconcileRequests(): Promise<void> {
        this.reconcilePassRunning = true;
        try {
            while (this.reconcileRequested) {
                this.reconcileRequested = false;
                this.runReconcilePass();
                if (this.reconcileRequested) {
                    this.diagnostics.reconcileCoalescedRerunCount += 1;
                }
            }
        }
        finally {
            this.reconcilePassRunning = false;
        }
    }

    private runReconcilePass(): void {
        this.diagnostics.reconcileRunCount += 1;
        const ownership = this.ledger.readPeerOwnership();
        const desiredPeerIds = new Set(ownership.groupsByPeerId.keys());
        this.removeRetainedDesiredPeers(desiredPeerIds, ownership.earlyDialPeerIds);
        this.ledger.retainedPeers.disconnectExpiredRetainedPeers(new Set(this.rtcQBox.knownPeerIds()), this.rtcQBox);
        disconnectAbsentPeerDials({
            desiredPeerIds,
            dialAllowedPeerIds: ownership.dialAllowedPeerIds,
            rtcQBox: this.rtcQBox
        });
        this.diagnostics.lastDesiredPeerCount = desiredPeerIds.size;

        const dialPlan = computeOutboundDialPlan({
            maxPeerConnections: this.ledger.maxPeerConnections,
            knownPeerIds: new Set(this.rtcQBox.knownPeerIds()),
            livePeerIds: new Set(this.rtcQBox.activePeerIds()),
            desiredPeerIds,
            earlyDialPeerIds: ownership.earlyDialPeerIds,
            connectablePeerIds: this.ledger.readConnectablePeerIds(ownership, this.rtcQBox),
            serverDesiredPeerIds: computeServerDesiredPeerIds(
                this.ledger.acceptedOverlayCache,
                this.ledger.groups().map((group) => group.groupRef),
                this.rtcQBox.input.sessionId
            )
        });
        this.recordDialsStarted(
            new WebRtcOutboundDialing({ rtcQBox: this.rtcQBox, dialPlan, ownership }).start()
        );

        this.reconcileRetainedPeers(desiredPeerIds);
        this.ledger.retainedPeers.setReconciledEarlyDialPeerIds(ownership.earlyDialPeerIds);

        this.options.onDesiredPeerIdsChanged?.({
            desiredPeerIds: [...desiredPeerIds],
            rttReportingPeerIds: this.rttReportingPeerIds({ degreeLimit: this.options.rttReportingDegreeLimit })
        });
        this.options.onReconcilePassEnded();
    }

    private reconcileRetainedPeers(desiredPeerIds: Set<PeerId>): void {
        const reconciledKnownPeerIds = new Set(this.rtcQBox.knownPeerIds());
        this.ledger.retainedPeers.removeUnknownRetainedPeers(reconciledKnownPeerIds);
        this.ledger.retainedPeers.retainUndesiredKnownPeers(desiredPeerIds, reconciledKnownPeerIds);
        this.ledger.retainedPeers.disconnectExpiredRetainedPeers(reconciledKnownPeerIds, this.rtcQBox);
        this.ledger.evictPeersOverCap(new Set(this.rtcQBox.knownPeerIds()), this.rtcQBox);
        this.startRetainedExpiryWake();
    }

    private recordDialsStarted(started: OutboundDialsStarted): void {
        this.diagnostics.connectAttemptCount += started.attemptCount;
        this.diagnostics.connectFailureCount += started.failureCount;
        this.diagnostics.connectDeferredBudgetCount += started.deferredCount;
        this.diagnostics.connectDeferredPacingCount += started.pacedCount;
        this.ledger.setWaitingDialCount(started.deferredCount + started.pacedCount);
    }

    private startRetainedExpiryWake(): void {
        this.stopRetainedExpiryWake();
        if (!this.reconcileWakesActive) {
            return;
        }

        const expiresAtEpochMs = this.ledger.retainedPeers.resolveEarliestRetainedExpiryAtEpochMs();
        if (expiresAtEpochMs === undefined) {
            return;
        }

        this.retainedExpiryWake = setTimeout(() => {
            this.retainedExpiryWake = undefined;
            void this.reconcileAllGroups().catch((caught) => {
                console.error('Failed to reconcile groups after a retention expired', toError(caught));
            });
        }, Math.max(0, expiresAtEpochMs - this.ledger.nowEpochMs()));
    }

    private stopRetainedExpiryWake(): void {
        if (this.retainedExpiryWake !== undefined) {
            clearTimeout(this.retainedExpiryWake);
            this.retainedExpiryWake = undefined;
        }
    }

    notifyClientPresenceChanged(): Promise<void> {
        return this.reconcileAllGroups();
    }

    async notifyOverlayTopologyChanged(): Promise<void> {
        this.ledger.invalidatePeerOwners();
        await Promise.all([this.reconcileAllGroups(), this.options.onOverlayAdopted()]);
    }

    private onlinePeerIds(): Set<PeerId> {
        const onlinePeerIds = new Set<PeerId>();

        for (const clientKey of this.ledger.clientCache.keys()) {
            const client = this.ledger.clientCache.read(clientKey) ??
                this.ledger.clientCache.peek(clientKey);
            if (!client) {
                continue;
            }

            for (const sessionId of readActiveClientSessionIds(client)) {
                onlinePeerIds.add(sessionId);
            }
        }

        return onlinePeerIds;
    }

    private rttReportingCandidatePeerIds(degreeLimit: number): readonly PeerId[] {
        const selectedPeerIds: PeerId[] = [];
        const seen = new Set<PeerId>([this.rtcQBox.input.sessionId]);
        const groups = [...this.ledger.groups()]
            .sort((left, right) => left.groupKey.localeCompare(right.groupKey));

        for (const group of groups) {
            const overlay = readOverlayForGroup(
                this.ledger.plannedOverlayCache,
                group.groupRef
            );
            const activePeerSessionIds = group.targetPeerIds();
            const selection = selectRttReportingPeers({
                localSessionId: this.rtcQBox.input.sessionId,
                degreeLimit,
                overlayNextHopSessionIds: overlay?.nextHopSessionIds ?? [],
                activePeerSessionIds,
                groupKey: group.groupKey
            });

            for (const peerId of selection.selectedPeerIds) {
                if (
                    seen.has(peerId) ||
                    !isRtcRttCanonicalReporter(
                        this.rtcQBox.input.sessionId,
                        peerId
                    )
                ) {
                    continue;
                }

                if (
                    !this.isRttReportingPeerEligibleAcrossSharedGroups(
                        peerId,
                        groups,
                        degreeLimit
                    )
                ) {
                    continue;
                }

                seen.add(peerId);
                selectedPeerIds.push(peerId);
            }
        }

        return selectedPeerIds;
    }

    private isRttReportingPeerEligibleAcrossSharedGroups(
        peerId: PeerId,
        groups: readonly WebRtcGroupService[],
        degreeLimit: number
    ): boolean {
        let hasSharedGroup = false;

        for (const group of groups) {
            const activePeerSessionIds = group.targetPeerIds();
            if (!activePeerSessionIds.includes(peerId)) {
                continue;
            }

            hasSharedGroup = true;
            if (
                !this.isRttReportingPairEligibleForGroup({
                    group,
                    peerId,
                    activePeerSessionIds,
                    degreeLimit
                })
            ) {
                return false;
            }
        }

        return hasSharedGroup;
    }

    private isRttReportingPairEligibleForGroup(
        pair: RttReportingGroupPair
    ): boolean {
        const overlay = readOverlayForGroup(
            this.ledger.plannedOverlayCache,
            pair.group.groupRef
        );
        const localSelection = selectRttReportingPeers({
            localSessionId: this.rtcQBox.input.sessionId,
            degreeLimit: pair.degreeLimit,
            overlayNextHopSessionIds: overlay?.nextHopSessionIds ?? [],
            activePeerSessionIds: pair.activePeerSessionIds,
            groupKey: pair.group.groupKey
        });
        if (localSelection.selectedPeerIds.includes(pair.peerId)) {
            return true;
        }

        if (overlay) {
            return false;
        }

        const peerSelection = selectRttReportingPeers({
            localSessionId: pair.peerId,
            degreeLimit: pair.degreeLimit,
            activePeerSessionIds: [
                this.rtcQBox.input.sessionId,
                ...pair.activePeerSessionIds
            ],
            groupKey: pair.group.groupKey
        });

        return peerSelection.selectedPeerIds.includes(this.rtcQBox.input.sessionId);
    }

    private removeRetainedDesiredPeers(desiredPeerIds: Set<PeerId>, earlyDialPeerIds: ReadonlySet<PeerId>): void {
        disconnectUnansweredRetainedDials({
            desiredPeerIds,
            retainedPeerConnections: this.ledger.retainedPeers.getRetainedPeerConnections(),
            rtcQBox: this.rtcQBox
        });
        this.ledger.retainedPeers.removeRetainedDesiredPeers(desiredPeerIds, earlyDialPeerIds);
    }
}
