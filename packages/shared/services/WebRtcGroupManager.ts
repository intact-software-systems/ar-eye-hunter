import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupId, OverlayInfo, PeerId } from '../api/api-config.ts';
import {
    readActiveClientSessionIds,
    type AnyClientPresence,
    type AnyGroupPresence
} from '../api/group-client-views.ts';
import type { GroupRef } from '../api/group-types.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { normalizeRttReportingDegreeLimit, selectRttReportingPeers } from '../rtc/rtt-reporting-policy.ts';
import {
    clonePeerOwners,
    emptyGroupManagerDiagnostics,
    type RetainedPeerConnection,
    type WebRtcGroupManagerDeleteOptions,
    type WebRtcGroupManagerDiagnostics,
    type WebRtcGroupManagerOptions,
    type WebRtcGroupManagerState,
    type WebRtcRttReportingPeerOptions
} from './webrtc-group-manager-contracts.ts';
import {
    computeOverlayRttReportingDegreeLimit,
    computeServerDesiredPeerIds,
    readAcceptedOverlayForGroup,
    readPlannedAuthoritativeOverlayForGroup
} from './webrtc-group-overlay-reading.ts';
import { computeOutboundDialPlan } from './webrtc-outbound-dial-plan.ts';
import type { WebRtcConnectionService } from './WebRtcConnectionService.ts';
import { WebRtcGroupService } from './WebRtcGroupService.ts';

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

export namespace WebRtcGroupManager {
    export interface Repositories {
        readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;
        readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>;
        readonly plannedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
        readonly acceptedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    }
}

export class WebRtcGroupManager {
    private readonly groupsByKey = new Map<string, WebRtcGroupService>();
    private readonly retainedPeerConnections = new Map<PeerId, RetainedPeerConnection>();
    private peerOwnersCache: ReadonlyMap<PeerId, readonly GroupId[]> | undefined;
    private reconcileInFlight: Promise<void> | undefined;
    private reconcileRequested = false;
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

    /**
     * Returns peer -> owning groups.
     */
    peerOwners(): ReadonlyMap<PeerId, readonly GroupId[]> {
        return clonePeerOwners(this.readPeerOwnersCache());
    }

    private readPeerOwnersCache(): ReadonlyMap<PeerId, readonly GroupId[]> {
        if (!this.peerOwnersCache) {
            this.peerOwnersCache = this.buildPeerOwners();
        }

        return this.peerOwnersCache;
    }

    private buildPeerOwners(): ReadonlyMap<PeerId, readonly GroupId[]> {
        const owners = new Map<PeerId, GroupId[]>();

        for (const group of this.groupsByKey.values()) {
            for (const peerId of this.targetPeerIdsForGroup(group)) {
                let groupIds = owners.get(peerId);
                if (!groupIds) {
                    groupIds = [];
                    owners.set(peerId, groupIds);
                }
                groupIds.push(group.groupRef.groupId);
            }
        }

        const readonlyOwners = new Map<PeerId, readonly GroupId[]>();
        for (const [peerId, groupIds] of owners.entries()) {
            readonlyOwners.set(peerId, [...groupIds]);
        }

        return readonlyOwners;
    }

    ownerGroupsOfPeer(peerId: PeerId): readonly GroupId[] {
        const groupIds = this.readPeerOwnersCache().get(peerId);
        return groupIds ? [...groupIds] : [];
    }

    isPeerOwnedByAnyGroup(peerId: PeerId): boolean {
        return this.readPeerOwnersCache().has(peerId);
    }

    state(): WebRtcGroupManagerState {
        const peerOwners = this.peerOwners();
        const desiredPeerIds = Array.from(peerOwners.keys());
        const onlinePeerIdSet = this.onlinePeerIds();
        const onlinePeerIds = Array.from(onlinePeerIdSet);
        const onlineDesiredPeerIds = desiredPeerIds.filter((peerId) => onlinePeerIdSet.has(peerId));
        const peerIdsWithNoReconnectableLanes = this.rtcQBox
            .peerIdsWithNoReconnectableLanes();

        return {
            groupIds: this.groupIds(),
            desiredPeerIds,
            onlinePeerIds,
            onlineDesiredPeerIds,
            connectablePeerIds: onlineDesiredPeerIds,
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
        const onlinePeerIds = this.onlinePeerIds();

        return this.rttReportingCandidatePeerIds(onlinePeerIds, degreeLimit)
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
     * guard silently lost the second trigger's mutations (M9).
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

    private async drainReconcileRequests(): Promise<void> {
        while (this.reconcileRequested) {
            this.reconcileRequested = false;
            this.runReconcilePass();
            if (this.reconcileRequested) {
                this.diagnostics.reconcileCoalescedRerunCount += 1;
            }
        }
    }

    private runReconcilePass(): void {
        this.diagnostics.reconcileRunCount += 1;
        const peerOwners = this.peerOwners();
        const desiredPeerIds = new Set(peerOwners.keys());
        const onlinePeerIds = this.onlinePeerIds();
        const peerIdsWithNoReconnectableLanes = new Set(
            this.rtcQBox.peerIdsWithNoReconnectableLanes()
        );
        let knownPeerIds = new Set(this.rtcQBox.knownPeerIds());
        this.removeRetainedDesiredPeers(desiredPeerIds);
        this.diagnostics.lastDesiredPeerCount = desiredPeerIds.size;

        const connectablePeerIds = Array.from(desiredPeerIds).filter(
            (peerId) => onlinePeerIds.has(peerId)
        );

        const dialPlan = computeOutboundDialPlan({
            maxPeerConnections: this.maxPeerConnections(),
            knownPeerIds,
            desiredPeerIds,
            connectablePeerIds: connectablePeerIds.filter(
                (peerId) => !peerIdsWithNoReconnectableLanes.has(peerId)
            ),
            serverDesiredPeerIds: computeServerDesiredPeerIds(
                this.acceptedOverlayCache,
                this.groups().map((group) => group.groupRef),
                this.rtcQBox.input.sessionId
            )
        });
        this.diagnostics.connectDeferredBudgetCount += dialPlan.deferredPeerIds.length;

        for (const peerId of dialPlan.peersToConnect) {
            this.diagnostics.connectAttemptCount += 1;
            const connected = this.rtcQBox.ensurePeerConnectionStarted(peerId);
            if (connected.left) {
                this.diagnostics.connectFailureCount += 1;
                const error = connected.left.kind === 'self'
                    ? undefined
                    : connected.left.error;
                console.error(
                    `Failed to connect peer ${peerId}. Owners=${
                        JSON.stringify(peerOwners.get(peerId) ?? [])
                    }. Cause=${connected.left.kind}`,
                    error
                );
            }
        }

        knownPeerIds = new Set(this.rtcQBox.knownPeerIds());
        this.removeUnknownRetainedPeers(knownPeerIds);
        this.retainUndesiredKnownPeers(desiredPeerIds, knownPeerIds);
        this.disconnectExpiredRetainedPeers(knownPeerIds);

        for (const peerId of this.retainedPeersToEvict(desiredPeerIds, knownPeerIds)) {
            try {
                this.rtcQBox.disconnectPeer(peerId, { resetAttemptBudget: false });
                this.retainedPeerConnections.delete(peerId);
                this.diagnostics.retainedEvictionCount += 1;
            }
            catch (error) {
                console.error(`Failed to disconnect retained peer ${peerId}`, error);
            }
        }

        this.options.onDesiredPeerIdsChanged?.();
    }

    /**
     * An established edge the previous overlay wanted survives a replan for
     * the grace window instead of being torn down in the same pass (M11) —
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
                console.error(`Failed to disconnect retained peer ${retained.peerId}`, error);
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
        this.peerOwnersCache = undefined;
    }

    private peerOwnersInvalidationCallbackId(groupKey: string): string {
        return `webrtc-group-manager:peer-owners:${groupKey}`;
    }

    private onlinePeerIds(): Set<PeerId> {
        const onlinePeerIds = new Set<PeerId>();
        const explicitlyOfflinePeerIds = new Set<PeerId>();

        for (const clientKey of this.clientCache.keys()) {
            const client = this.clientCache.read(clientKey) ??
                this.clientCache.peek(clientKey);
            if (!client) {
                continue;
            }

            for (const sessionId of readActiveClientSessionIds(client)) {
                onlinePeerIds.add(sessionId);
            }
            if (!('principal' in client) && !client.isOnline) {
                explicitlyOfflinePeerIds.add(client.sessionId);
            }
        }

        // Group presence and client presence converge independently. A fresh
        // room point read can therefore observe a newly active session before
        // the client collection does. The group is authoritative for its own
        // active sessions, so that cache lag must not suppress the RTC dial.
        for (const group of this.groupsByKey.values()) {
            for (const peerId of group.targetPeerIds()) {
                if (!explicitlyOfflinePeerIds.has(peerId)) {
                    onlinePeerIds.add(peerId);
                }
            }
        }

        return onlinePeerIds;
    }

    private targetPeerIdsForGroup(group: WebRtcGroupService): readonly PeerId[] {
        const overlay = readAcceptedOverlayForGroup(
            this.acceptedOverlayCache,
            group.groupRef
        );
        if (overlay) {
            return overlay.nextHopSessionIds.filter(
                (peerId) => peerId !== this.rtcQBox.input.sessionId
            );
        }

        return group.targetPeerIds();
    }

    private rttReportingCandidatePeerIds(
        onlinePeerIds: ReadonlySet<PeerId>,
        degreeLimit: number
    ): readonly PeerId[] {
        const selectedPeerIds: PeerId[] = [];
        const seen = new Set<PeerId>([this.rtcQBox.input.sessionId]);
        const groups = [...this.groupsByKey.values()]
            .sort((left, right) => left.groupKey.localeCompare(right.groupKey));

        for (const group of groups) {
            const overlay = readPlannedAuthoritativeOverlayForGroup(
                this.plannedOverlayCache,
                group.groupRef
            );
            const activePeerSessionIds = group.targetPeerIds()
                .filter((peerId) => onlinePeerIds.has(peerId));
            const selection = selectRttReportingPeers({
                localSessionId: this.rtcQBox.input.sessionId,
                degreeLimit,
                overlayNextHopSessionIds: overlay?.nextHopSessionIds ?? [],
                activePeerSessionIds,
                groupKey: group.groupKey
            });

            for (const peerId of selection.selectedPeerIds) {
                if (seen.has(peerId)) {
                    continue;
                }

                if (
                    !this.isRttReportingPeerEligibleAcrossSharedGroups(
                        peerId,
                        groups,
                        onlinePeerIds,
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
        onlinePeerIds: ReadonlySet<PeerId>,
        degreeLimit: number
    ): boolean {
        let hasSharedGroup = false;

        for (const group of groups) {
            const activePeerSessionIds = group.targetPeerIds()
                .filter((candidateId) => onlinePeerIds.has(candidateId));
            if (!activePeerSessionIds.includes(peerId)) {
                continue;
            }

            hasSharedGroup = true;
            if (
                !this.isRttReportingPairEligibleForGroup(
                    group,
                    peerId,
                    activePeerSessionIds,
                    degreeLimit
                )
            ) {
                return false;
            }
        }

        return hasSharedGroup;
    }

    private isRttReportingPairEligibleForGroup(
        group: WebRtcGroupService,
        peerId: PeerId,
        activePeerSessionIds: readonly PeerId[],
        degreeLimit: number
    ): boolean {
        const overlay = readPlannedAuthoritativeOverlayForGroup(
            this.plannedOverlayCache,
            group.groupRef
        );
        const localSelection = selectRttReportingPeers({
            localSessionId: this.rtcQBox.input.sessionId,
            degreeLimit,
            overlayNextHopSessionIds: overlay?.nextHopSessionIds ?? [],
            activePeerSessionIds,
            groupKey: group.groupKey
        });
        if (localSelection.selectedPeerIds.includes(peerId)) {
            return true;
        }

        if (overlay) {
            return false;
        }

        const peerSelection = selectRttReportingPeers({
            localSessionId: peerId,
            degreeLimit,
            activePeerSessionIds: [
                this.rtcQBox.input.sessionId,
                ...activePeerSessionIds
            ],
            groupKey: group.groupKey
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
