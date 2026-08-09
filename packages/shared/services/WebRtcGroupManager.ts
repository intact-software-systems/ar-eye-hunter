import { WebRtcConnectionService } from './WebRtcConnectionService.ts';
import { WebRtcGroupService, } from './WebRtcGroupService.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { GroupId, OverlayInfo, PeerId } from '../api/api-config.ts';
import type { GroupRef } from '../api/group-types.ts';
import {
    type AnyClientPresence,
    type AnyGroupPresence,
    readActiveClientSessionIds,
} from '../api/group-client-views.ts';
import {
    isOverlayForGroupRef,
    toScopedOverlayId,
    toWebRtcGroupKey,
} from '@shared/api/api-type-utils.ts';
import {
    normalizeRttReportingDegreeLimit,
    selectRttReportingPeers,
} from '../rtc/rtt-reporting-policy.ts';
import {
    clonePeerOwners,
    emptyGroupManagerDiagnostics,
    type RetainedPeerConnection,
    type WebRtcGroupManagerDeleteOptions,
    type WebRtcGroupManagerDiagnostics,
    type WebRtcGroupManagerOptions,
    type WebRtcGroupManagerState,
    type WebRtcRttReportingPeerOptions,
} from './webrtc-group-manager-contracts.ts';

export type {
    WebRtcGroupManagerDeleteOptions,
    WebRtcGroupManagerDiagnostics,
    WebRtcGroupManagerOptions,
    WebRtcGroupManagerState,
    WebRtcRttReportingPeerOptions,
} from './webrtc-group-manager-contracts.ts';

export const DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS = 10;
export const MIN_WEBRTC_MAX_PEER_CONNECTIONS = 5;

export class WebRtcGroupManager {
    private readonly groupsByKey = new Map<string, WebRtcGroupService>();
    private readonly retainedPeerConnections = new Map<PeerId, RetainedPeerConnection>();
    private peerOwnersCache: ReadonlyMap<PeerId, readonly GroupId[]> | undefined;
    private reconcileInFlight: Promise<void> | undefined;
    private retainedOrder = 0;
    private readonly diagnostics = emptyGroupManagerDiagnostics();

    constructor(
        public readonly rtcQBox: WebRtcConnectionService,
        public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>,
        public readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>,
        public readonly overlayCache?: ReadableKeyedValues<string, OverlayInfo>,
        public readonly options: WebRtcGroupManagerOptions = {},
    ) {
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
                this.groupCache,
            );
            service.onStateDo(
                this.peerOwnersInvalidationCallbackId(groupKey),
                async () => {
                    this.invalidatePeerOwners();
                },
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
        options: WebRtcGroupManagerDeleteOptions = {},
    ): Promise<boolean> {
        const groupKey = toWebRtcGroupKey(group);
        const service = this.groupsByKey.get(groupKey);
        const existed = this.groupsByKey.delete(groupKey);
        const retainedGroupExisted = this.hasRetainedGroup(groupKey);
        if (!existed && !retainedGroupExisted) {
            return false;
        }

        service?.removeOnStateCallback(
            this.peerOwnersInvalidationCallbackId(groupKey),
        );
        this.invalidatePeerOwners();

        if (options.retainConnections && service) {
            this.retainKnownPeersForGroup(service, groupKey);
        } else {
            this.removeRetainedGroup(groupKey);
        }

        await this.reconcileAllGroups();
        return true;
    }

    async clear(): Promise<void> {
        for (const [groupKey, service] of this.groupsByKey.entries()) {
            service.removeOnStateCallback(
                this.peerOwnersInvalidationCallbackId(groupKey),
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
        const onlineDesiredPeerIds = desiredPeerIds.filter((peerId) =>
            onlinePeerIdSet.has(peerId)
        );
        const peerIdsWithNoReconnectableLanes = this.rtcQBox
            .peerIdsWithNoReconnectableLanes();

        return {
            groupIds: this.groupIds(),
            desiredPeerIds,
            onlinePeerIds,
            onlineDesiredPeerIds,
            connectablePeerIds: onlineDesiredPeerIds,
            peerIdsWithNoReconnectableLanes,
            peerOwners,
        };
    }

    rttReportingPeerIds(
        options: WebRtcRttReportingPeerOptions = {},
    ): readonly PeerId[] {
        const degreeLimit = normalizeRttReportingDegreeLimit(
            options.degreeLimit,
            this.overlayRttReportingDegreeLimit(),
        );
        const onlinePeerIds = this.onlinePeerIds();

        return this.rttReportingCandidatePeerIds(onlinePeerIds, degreeLimit)
            .slice(0, degreeLimit);
    }

    async acceptGroupUpdate(
        snapshot: AnyGroupPresence,
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

    private async reconcileAllGroups(): Promise<void> {
        if (this.reconcileInFlight) {
            this.diagnostics.reconcileAwaitedInFlightCount += 1;
            await this.reconcileInFlight;
            return;
        }

        const run = (async () => {
            this.diagnostics.reconcileRunCount += 1;
            const peerOwners = this.peerOwners();
            const desiredPeerIds = new Set(peerOwners.keys());
            const onlinePeerIds = this.onlinePeerIds();
            const peerIdsWithNoReconnectableLanes = new Set(
                this.rtcQBox.peerIdsWithNoReconnectableLanes(),
            );
            let knownPeerIds = new Set(this.rtcQBox.knownPeerIds());
            this.removeRetainedDesiredPeers(desiredPeerIds);
            this.diagnostics.lastDesiredPeerCount = desiredPeerIds.size;

            const connectablePeerIds = Array.from(desiredPeerIds).filter(
                (peerId) => onlinePeerIds.has(peerId),
            );

            const peersToConnect = connectablePeerIds.filter(
                (peerId) => !peerIdsWithNoReconnectableLanes.has(peerId),
            );

            for (const peerId of peersToConnect) {
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
                        error,
                    );
                }
            }

            knownPeerIds = new Set(this.rtcQBox.knownPeerIds());
            this.removeUnknownRetainedPeers(knownPeerIds);
            const retainedPeerIds = new Set(this.retainedPeerConnections.keys());
            const peersToDisconnect = Array.from(knownPeerIds).filter(
                (peerId) => !desiredPeerIds.has(peerId) && !retainedPeerIds.has(peerId),
            );

            for (const peerId of peersToDisconnect) {
                try {
                    this.rtcQBox.disconnectPeer(peerId);
                    this.retainedPeerConnections.delete(peerId);
                    this.diagnostics.disconnectCount += 1;
                } catch (error) {
                    console.error(`Failed to disconnect peer ${peerId}`, error);
                }
            }

            for (const peerId of this.retainedPeersToEvict(desiredPeerIds, knownPeerIds)) {
                try {
                    this.rtcQBox.disconnectPeer(peerId);
                    this.retainedPeerConnections.delete(peerId);
                    this.diagnostics.retainedEvictionCount += 1;
                } catch (error) {
                    console.error(`Failed to disconnect retained peer ${peerId}`, error);
                }
            }

            this.options.onDesiredPeerIdsChanged?.();
        })();

        this.reconcileInFlight = run;
        try {
            await run;
        } finally {
            if (this.reconcileInFlight === run) {
                this.reconcileInFlight = undefined;
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
        const overlay = this.readOverlayForGroup(group.groupRef);
        if (overlay) {
            return overlay.nextHopSessionIds.filter(
                (peerId) => peerId !== this.rtcQBox.input.sessionId,
            );
        }

        return group.targetPeerIds();
    }

    private rttReportingCandidatePeerIds(
        onlinePeerIds: ReadonlySet<PeerId>,
        degreeLimit: number,
    ): readonly PeerId[] {
        const selectedPeerIds: PeerId[] = [];
        const seen = new Set<PeerId>([this.rtcQBox.input.sessionId]);
        const groups = [...this.groupsByKey.values()]
            .sort((left, right) => left.groupKey.localeCompare(right.groupKey));

        for (const group of groups) {
            const overlay = this.readAuthoritativeOverlayForGroup(group.groupRef);
            const activePeerSessionIds = group.targetPeerIds()
                .filter((peerId) => onlinePeerIds.has(peerId));
            const selection = selectRttReportingPeers({
                localSessionId: this.rtcQBox.input.sessionId,
                degreeLimit,
                overlayNextHopSessionIds: overlay?.nextHopSessionIds ?? [],
                activePeerSessionIds,
                groupKey: group.groupKey,
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
                        degreeLimit,
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
        degreeLimit: number,
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
                    degreeLimit,
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
        degreeLimit: number,
    ): boolean {
        const overlay = this.readAuthoritativeOverlayForGroup(group.groupRef);
        const localSelection = selectRttReportingPeers({
            localSessionId: this.rtcQBox.input.sessionId,
            degreeLimit,
            overlayNextHopSessionIds: overlay?.nextHopSessionIds ?? [],
            activePeerSessionIds,
            groupKey: group.groupKey,
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
                ...activePeerSessionIds,
            ],
            groupKey: group.groupKey,
        });

        return peerSelection.selectedPeerIds.includes(this.rtcQBox.input.sessionId);
    }

    private overlayRttReportingDegreeLimit(): number | undefined {
        const limits = this.groups()
            .map((group) => this.readOverlayForGroup(group.groupRef)?.degreeLimit)
            .filter((value): value is number => value !== undefined);
        return limits.length > 0 ? Math.min(...limits) : undefined;
    }

    private readOverlayForGroup(groupRef: GroupRef): OverlayInfo | undefined {
        if (!this.overlayCache) {
            return undefined;
        }

        const scopedOverlayId = toScopedOverlayId(groupRef);
        const scoped = this.overlayCache.read(scopedOverlayId) ??
            this.overlayCache.peek(scopedOverlayId);
        if (scoped) {
            return scoped.state === 'removed' ? undefined : scoped;
        }

        const legacy = this.overlayCache.read(groupRef.groupId) ??
            this.overlayCache.peek(groupRef.groupId);
        return legacy && legacy.state !== 'removed' &&
                isOverlayForGroupRef(legacy, groupRef)
            ? legacy
            : undefined;
    }

    private readAuthoritativeOverlayForGroup(groupRef: GroupRef): OverlayInfo | undefined {
        const overlay = this.readOverlayForGroup(groupRef);
        return overlay?.degreeLimit !== undefined ? overlay : undefined;
    }

    private retainKnownPeersForGroup(
        group: WebRtcGroupService,
        groupKey: string,
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
        knownPeerIds: Set<PeerId>,
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
            Math.floor(requested),
        );
    }
}
