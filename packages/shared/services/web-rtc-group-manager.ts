import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { toError } from '../resilience/to-error.ts';
// dprint-ignore
import type {
    GroupId,
    OverlayInfo,
    PeerId
} from '../api/api-config.ts';
import {
    readActiveClientSessionIds,
    type AnyClientPresence,
    type AnyGroupPresence
} from '../api/group-client-views.ts';
import type { GroupRef } from '../api/group-types.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import {
    isRtcRttCanonicalReporter,
    normalizeRttReportingDegreeLimit,
    selectRttReportingPeers
} from '../rtc/rtt-reporting-policy.ts';
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';
import { WebRtcGroupService } from './web-rtc-group-service.ts';
import { selectGroupDialPeerIds } from './webrtc-group-dial-policy.ts';
import {
    clonePeerOwners,
    emptyGroupManagerDiagnostics,
    type RetainedPeerConnection,
    type WebRtcGroupManagerDeleteOptions,
    type WebRtcGroupManagerDiagnostics,
    type WebRtcGroupManagerOptions,
    type WebRtcGroupManagerState,
    type WebRtcPeerOwnership,
    type WebRtcRttReportingPeerOptions
} from './webrtc-group-manager-contracts.ts';
import {
    computeOverlayRttReportingDegreeLimit,
    computeServerDesiredPeerIds,
    readOverlayForGroup
} from './webrtc-group-overlay-reading.ts';
import { computeOutboundDialPlan } from './webrtc-outbound-dial-plan.ts';
import { WebRtcOutboundDialing } from './webrtc-outbound-dialing.ts';

export type {
    WebRtcGroupManagerDeleteOptions,
    WebRtcGroupManagerDiagnostics,
    WebRtcGroupManagerOptions,
    WebRtcGroupManagerState,
    WebRtcRttReportingPeerOptions
} from './webrtc-group-manager-contracts.ts';

export const DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS = 10;
export const MIN_WEBRTC_MAX_PEER_CONNECTIONS = 5;
export const DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS = 15_000;

interface RttReportingGroupPair {
    readonly group: WebRtcGroupService;
    readonly peerId: PeerId;
    readonly activePeerSessionIds: readonly PeerId[];
    readonly degreeLimit: number;
}

export namespace WebRtcGroupManager {
    export interface Repositories {
        readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;
        readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>;
        readonly plannedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
        readonly acceptedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    }
}

export class WebRtcGroupManager {
    private static readonly SETUP_COMPLETION_CALLBACK_ID = 'webrtc-group-manager:setup-completion';

    private readonly groupsByKey = new Map<string, WebRtcGroupService>();
    private readonly retainedPeerConnections = new Map<PeerId, RetainedPeerConnection>();
    private peerOwnershipCache: WebRtcPeerOwnership | undefined;
    private reconcileInFlight: Promise<void> | undefined;
    private reconcileRequested = false;
    private reconcilePassRunning = false;
    private scheduledWake: Promise<void> | undefined;
    private waitingDialCount = 0;
    private retainedOrder = 0;
    private readonly diagnostics = emptyGroupManagerDiagnostics();

    public readonly rtcQBox: WebRtcConnectionService;
    public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;
    public readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>;
    private readonly plannedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    private readonly acceptedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    public readonly options: WebRtcGroupManagerOptions;

    constructor(
        rtcQBox: WebRtcConnectionService,
        repositories: WebRtcGroupManager.Repositories,
        options: WebRtcGroupManagerOptions = {}
    ) {
        this.rtcQBox = rtcQBox;
        this.groupCache = repositories.groupCache;
        this.clientCache = repositories.clientCache;
        this.plannedOverlayCache = repositories.plannedOverlayCache;
        this.acceptedOverlayCache = repositories.acceptedOverlayCache;
        this.options = options;
    }

    /**
     * Every setup ending frees a slot under the in-flight bound (product
     * decision 18), so an ending re-plans the dials that wait for one. The
     * composition root starts this once the service and manager exist; shutdown
     * stops it before tearing peers down, because shutdown removes peers their
     * groups still want and every removal would otherwise dial them back.
     */
    startReconcileWakes(): void {
        this.rtcQBox.onRtcPeerLifecycleDo(WebRtcGroupManager.SETUP_COMPLETION_CALLBACK_ID, {
            onCreated: () => {},
            onDeleted: () => this.wakeAfterSetupEnded(),
            onEstablished: () => this.wakeAfterSetupEnded()
        });
    }

    stopReconcileWakes(): void {
        this.rtcQBox.removeRtcPeerLifecycleById(WebRtcGroupManager.SETUP_COMPLETION_CALLBACK_ID);
    }

    /** Settles after the reconcile that a pending setup-ending wake or an in-flight update will run. */
    whenReconciled(): Promise<void> {
        return this.scheduledWake ?? this.reconcileInFlight ?? Promise.resolve();
    }

    readDiagnostics(): WebRtcGroupManagerDiagnostics {
        return { ...this.diagnostics };
    }

    resetDiagnostics(): void {
        Object.assign(this.diagnostics, emptyGroupManagerDiagnostics());
    }

    getOrCreate(group: GroupRef): WebRtcGroupService {
        const groupKey = toWebRtcGroupKey(group);
        let service = this.groupsByKey.get(groupKey);

        if (!service) {
            service = new WebRtcGroupService(
                this.rtcQBox,
                group,
                this.groupCache
            );
            service.onStateDo(
                this.peerOwnersInvalidationCallbackId(groupKey),
                async () => {
                    this.invalidatePeerOwners();
                }
            );
            this.groupsByKey.set(groupKey, service);
        }

        return service;
    }

    getIfPresent(group: GroupRef): WebRtcGroupService | undefined {
        return this.groupsByKey.get(toWebRtcGroupKey(group));
    }

    has(group: GroupRef): boolean {
        return this.groupsByKey.has(toWebRtcGroupKey(group));
    }

    async delete(
        group: GroupRef,
        options: WebRtcGroupManagerDeleteOptions = {}
    ): Promise<boolean> {
        const groupKey = toWebRtcGroupKey(group);
        const service = this.groupsByKey.get(groupKey);
        const existed = this.groupsByKey.delete(groupKey);
        const retainedGroupExisted = this.hasRetainedGroup(groupKey);
        if (!existed && !retainedGroupExisted) {
            return false;
        }

        service?.removeOnStateCallback(
            this.peerOwnersInvalidationCallbackId(groupKey)
        );
        this.invalidatePeerOwners();

        if (options.retainConnections && service) {
            this.retainKnownPeersForGroup(service, groupKey);
        }
        else {
            this.removeRetainedGroup(groupKey);
        }

        await this.reconcileAllGroups();
        return true;
    }

    async clear(): Promise<void> {
        for (const [groupKey, service] of this.groupsByKey.entries()) {
            service.removeOnStateCallback(
                this.peerOwnersInvalidationCallbackId(groupKey)
            );
        }
        this.groupsByKey.clear();
        this.retainedPeerConnections.clear();
        this.invalidatePeerOwners();
        await this.reconcileAllGroups();
    }

    size(): number {
        return this.groupsByKey.size;
    }

    groupIds(): readonly GroupId[] {
        return this.groups().map((group) => group.groupRef.groupId);
    }

    groups(): readonly WebRtcGroupService[] {
        return Array.from(this.groupsByKey.values());
    }

    peerOwners(): ReadonlyMap<PeerId, readonly GroupId[]> {
        return clonePeerOwners(this.readPeerOwnership().groupsByPeerId);
    }

    private readPeerOwnership(): WebRtcPeerOwnership {
        if (!this.peerOwnershipCache) {
            this.peerOwnershipCache = this.computePeerOwnership();
        }

        return this.peerOwnershipCache;
    }

    private computePeerOwnership(): WebRtcPeerOwnership {
        const owners = new Map<PeerId, GroupId[]>();
        const groupKeysByPeerId = new Map<PeerId, string[]>();
        const dialAllowedPeerIds = new Set<PeerId>();
        const maxConcurrentEdgeSetupsByGroupKey = new Map<string, number>();

        for (const group of this.groupsByKey.values()) {
            const snapshot = group.readGroup();
            if (!snapshot) {
                continue;
            }
            maxConcurrentEdgeSetupsByGroupKey.set(group.groupKey, snapshot.group.memberPolicy.maxConcurrentEdgeSetups);
            const groupPresentPeerIds = new Set(group.targetPeerIds());
            for (const peerId of this.dialPeerIdsForSnapshot(snapshot, group.groupRef)) {
                owners.set(peerId, [...(owners.get(peerId) ?? []), group.groupRef.groupId]);
                groupKeysByPeerId.set(peerId, [...(groupKeysByPeerId.get(peerId) ?? []), group.groupKey]);
                if (groupPresentPeerIds.has(peerId)) {
                    dialAllowedPeerIds.add(peerId);
                }
            }
        }

        return { groupsByPeerId: owners, dialAllowedPeerIds, groupKeysByPeerId, maxConcurrentEdgeSetupsByGroupKey };
    }

    ownerGroupsOfPeer(peerId: PeerId): readonly GroupId[] {
        const groupIds = this.readPeerOwnership().groupsByPeerId.get(peerId);
        return groupIds ? [...groupIds] : [];
    }

    isPeerDialAllowedByAnyGroup(peerId: PeerId): boolean {
        return this.readPeerOwnership().dialAllowedPeerIds.has(peerId);
    }

    state(): WebRtcGroupManagerState {
        const peerOwners = this.peerOwners();
        const desiredPeerIds = Array.from(peerOwners.keys());
        const onlinePeerIdSet = this.onlinePeerIds();
        const onlinePeerIds = Array.from(onlinePeerIdSet);
        const onlineDesiredPeerIds = desiredPeerIds.filter((peerId) => onlinePeerIdSet.has(peerId));
        const groupPresentDesiredPeerIds = this.readPeerOwnership().dialAllowedPeerIds;
        const connectablePeerIds = desiredPeerIds.filter((peerId) => groupPresentDesiredPeerIds.has(peerId));
        const peerIdsWithNoReconnectableLanes = this.rtcQBox
            .peerIdsWithNoReconnectableLanes();

        return {
            groupIds: this.groupIds(),
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
                this.plannedOverlayCache,
                this.groups().map((group) => group.groupRef)
            )
        );
        return this.rttReportingCandidatePeerIds(degreeLimit)
            .slice(0, degreeLimit);
    }

    async acceptGroupUpdate(
        snapshot: AnyGroupPresence
    ): Promise<WebRtcGroupService> {
        const group = this.getOrCreate(snapshot.group);
        await group.acceptGroupUpdate(snapshot);
        await this.reconcileAllGroups();
        return group;
    }

    async refreshAllGroups(): Promise<void> {
        for (const group of this.groupsByKey.values()) {
            await group.refreshFromCache();
        }

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

    private wakeAfterSetupEnded(): void {
        if (this.waitingDialCount === 0) {
            return;
        }
        if (this.reconcilePassRunning) {
            // The pass ended a setup after its own dial loop; the drain loop
            // re-plans once more instead of a wake landing mid-pass.
            this.reconcileRequested = true;
            return;
        }
        if (this.scheduledWake) {
            return;
        }
        // Deferred past the notification that raised it, so every observer sees
        // the ending before the dials it releases.
        this.scheduledWake = Promise.resolve()
            .then(() => {
                this.scheduledWake = undefined;
                return this.reconcileAllGroups();
            })
            .catch((caught) => {
                console.error('Failed to reconcile groups after a setup ended', toError(caught));
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
        const ownership = this.readPeerOwnership();
        const desiredPeerIds = new Set(ownership.groupsByPeerId.keys());
        const peerIdsWithNoReconnectableLanes = new Set(
            this.rtcQBox.peerIdsWithNoReconnectableLanes()
        );
        this.removeRetainedDesiredPeers(desiredPeerIds);
        this.diagnostics.lastDesiredPeerCount = desiredPeerIds.size;

        const dialPlan = computeOutboundDialPlan({
            maxPeerConnections: this.maxPeerConnections(),
            knownPeerIds: new Set(this.rtcQBox.knownPeerIds()),
            livePeerIds: new Set(this.rtcQBox.activePeerIds()),
            desiredPeerIds,
            connectablePeerIds: Array.from(desiredPeerIds).filter(
                (peerId) => ownership.dialAllowedPeerIds.has(peerId) && !peerIdsWithNoReconnectableLanes.has(peerId)
            ),
            serverDesiredPeerIds: computeServerDesiredPeerIds(
                this.acceptedOverlayCache,
                this.groups().map((group) => group.groupRef),
                this.rtcQBox.input.sessionId
            )
        });
        const started = new WebRtcOutboundDialing({ rtcQBox: this.rtcQBox, dialPlan, ownership }).start();
        this.diagnostics.connectAttemptCount += started.attemptCount;
        this.diagnostics.connectFailureCount += started.failureCount;
        this.diagnostics.connectDeferredBudgetCount += started.deferredCount;
        this.diagnostics.connectDeferredPacingCount += started.pacedCount;
        this.waitingDialCount = started.deferredCount + started.pacedCount;

        const reconciledKnownPeerIds = new Set(this.rtcQBox.knownPeerIds());
        this.removeUnknownRetainedPeers(reconciledKnownPeerIds);
        this.retainUndesiredKnownPeers(desiredPeerIds, reconciledKnownPeerIds);
        this.disconnectExpiredRetainedPeers(reconciledKnownPeerIds);
        this.evictRetainedPeers(desiredPeerIds, reconciledKnownPeerIds);

        this.options.onDesiredPeerIdsChanged?.({
            desiredPeerIds: [...desiredPeerIds],
            rttReportingPeerIds: this.rttReportingPeerIds({ degreeLimit: this.options.rttReportingDegreeLimit })
        });
    }

    private evictRetainedPeers(
        desiredPeerIds: Set<PeerId>,
        knownPeerIds: Set<PeerId>
    ): void {
        for (const peerId of this.retainedPeersToEvict(desiredPeerIds, knownPeerIds)) {
            try {
                this.rtcQBox.disconnectPeer(peerId, { resetAttemptBudget: false });
                this.retainedPeerConnections.delete(peerId);
                this.diagnostics.retainedEvictionCount += 1;
            }
            catch (error) {
                console.error(`Failed to disconnect retained peer ${peerId}`, toError(error));
            }
        }
    }

    /**
     * An established edge the previous overlay wanted survives a replan for
     * the grace window instead of being torn down in the same pass —
     * a flapping overlay converges to zero churn because the edge is still
     * there when the next epoch wants it back.
     */
    private retainUndesiredKnownPeers(
        desiredPeerIds: Set<PeerId>,
        knownPeerIds: Set<PeerId>
    ): void {
        for (const peerId of knownPeerIds) {
            if (desiredPeerIds.has(peerId) || this.retainedPeerConnections.has(peerId)) {
                continue;
            }

            this.retainedPeerConnections.set(peerId, {
                peerId,
                groupKey: null,
                groupId: null,
                retainedOrder: this.retainedOrder++,
                reason: 'overlay-transition',
                expiresAtEpochMs: this.now() + this.overlayTransitionGraceMs()
            });
            this.diagnostics.retainedCreatedCount += 1;
        }
    }

    private disconnectExpiredRetainedPeers(knownPeerIds: Set<PeerId>): void {
        const now = this.now();
        for (const retained of Array.from(this.retainedPeerConnections.values())) {
            if (
                retained.expiresAtEpochMs === null ||
                retained.expiresAtEpochMs > now ||
                !knownPeerIds.has(retained.peerId)
            ) {
                continue;
            }

            try {
                this.rtcQBox.disconnectPeer(retained.peerId, { resetAttemptBudget: false });
                this.retainedPeerConnections.delete(retained.peerId);
                this.diagnostics.disconnectCount += 1;
                this.diagnostics.retainedExpiredCount += 1;
            }
            catch (error) {
                console.error(`Failed to disconnect retained peer ${retained.peerId}`, toError(error));
            }
        }
    }

    notifyClientPresenceChanged(): Promise<void> {
        return this.reconcileAllGroups();
    }

    notifyOverlayTopologyChanged(): Promise<void> {
        this.invalidatePeerOwners();
        return this.reconcileAllGroups();
    }

    private invalidatePeerOwners(): void {
        this.peerOwnershipCache = undefined;
    }

    private peerOwnersInvalidationCallbackId(groupKey: string): string {
        return `webrtc-group-manager:peer-owners:${groupKey}`;
    }

    private onlinePeerIds(): Set<PeerId> {
        const onlinePeerIds = new Set<PeerId>();

        for (const clientKey of this.clientCache.keys()) {
            const client = this.clientCache.read(clientKey) ??
                this.clientCache.peek(clientKey);
            if (!client) {
                continue;
            }

            for (const sessionId of readActiveClientSessionIds(client)) {
                onlinePeerIds.add(sessionId);
            }
        }

        return onlinePeerIds;
    }

    private targetPeerIdsForGroup(group: WebRtcGroupService): readonly PeerId[] {
        const snapshot = group.readGroup();
        return snapshot ? this.dialPeerIdsForSnapshot(snapshot, group.groupRef) : [];
    }

    private dialPeerIdsForSnapshot(snapshot: AnyGroupPresence, groupRef: GroupRef): readonly PeerId[] {
        return selectGroupDialPeerIds({
            lifecycleState: snapshot.group.lifecycleState,
            localSessionId: this.rtcQBox.input.sessionId,
            planned: readOverlayForGroup(this.plannedOverlayCache, groupRef),
            accepted: readOverlayForGroup(this.acceptedOverlayCache, groupRef)
        });
    }

    private rttReportingCandidatePeerIds(degreeLimit: number): readonly PeerId[] {
        const selectedPeerIds: PeerId[] = [];
        const seen = new Set<PeerId>([this.rtcQBox.input.sessionId]);
        const groups = [...this.groupsByKey.values()]
            .sort((left, right) => left.groupKey.localeCompare(right.groupKey));

        for (const group of groups) {
            const overlay = readOverlayForGroup(
                this.plannedOverlayCache,
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
            this.plannedOverlayCache,
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

    private retainKnownPeersForGroup(
        group: WebRtcGroupService,
        groupKey: string
    ): void {
        const knownPeerIds = new Set(this.rtcQBox.knownPeerIds());
        for (const peerId of this.targetPeerIdsForGroup(group)) {
            if (!knownPeerIds.has(peerId) || this.retainedPeerConnections.has(peerId)) {
                continue;
            }

            this.retainedPeerConnections.set(peerId, {
                peerId,
                groupKey,
                groupId: group.groupRef.groupId,
                retainedOrder: this.retainedOrder++,
                reason: 'left-group',
                expiresAtEpochMs: null
            });
        }
    }

    private hasRetainedGroup(groupKey: string): boolean {
        return Array.from(this.retainedPeerConnections.values())
            .some((retained) => retained.groupKey === groupKey);
    }

    private removeRetainedGroup(groupKey: string): void {
        for (const [peerId, retained] of this.retainedPeerConnections.entries()) {
            if (retained.groupKey === groupKey) {
                this.retainedPeerConnections.delete(peerId);
            }
        }
    }

    private removeRetainedDesiredPeers(desiredPeerIds: Set<PeerId>): void {
        for (const peerId of desiredPeerIds) {
            this.retainedPeerConnections.delete(peerId);
        }
    }

    private removeUnknownRetainedPeers(knownPeerIds: Set<PeerId>): void {
        for (const peerId of this.retainedPeerConnections.keys()) {
            if (!knownPeerIds.has(peerId)) {
                this.retainedPeerConnections.delete(peerId);
            }
        }
    }

    private retainedPeersToEvict(
        desiredPeerIds: Set<PeerId>,
        knownPeerIds: Set<PeerId>
    ): readonly PeerId[] {
        const activeKnownCount = Array.from(knownPeerIds)
            .filter((peerId) => desiredPeerIds.has(peerId))
            .length;
        const retainedKnownPeers = Array.from(this.retainedPeerConnections.values())
            .filter((retained) =>
                knownPeerIds.has(retained.peerId) &&
                !desiredPeerIds.has(retained.peerId)
            )
            .sort((left, right) => left.retainedOrder - right.retainedOrder);
        const retainedBudget = Math.max(0, this.maxPeerConnections() - activeKnownCount);
        const evictCount = retainedKnownPeers.length - retainedBudget;
        if (evictCount <= 0) {
            return [];
        }

        return retainedKnownPeers
            .slice(0, evictCount)
            .map((retained) => retained.peerId);
    }

    private maxPeerConnections(): number {
        const requested = this.options.maxPeerConnections;
        if (
            requested === undefined ||
            !Number.isFinite(requested) ||
            requested <= 0
        ) {
            return DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS;
        }

        return Math.max(
            MIN_WEBRTC_MAX_PEER_CONNECTIONS,
            Math.floor(requested)
        );
    }

    private overlayTransitionGraceMs(): number {
        return Math.max(
            0,
            this.options.overlayTransitionGraceMs ??
                DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS
        );
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
}
