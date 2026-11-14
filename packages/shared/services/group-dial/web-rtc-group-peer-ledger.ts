import type {
    GroupId,
    OverlayInfo,
    PeerId
} from '../../api/api-config.ts';
import { toWebRtcGroupKey } from '../../api/api-type-utils.ts';
import type {
    AnyClientPresence,
    AnyGroupPresence
} from '../../api/group-client-views.ts';
import type { GroupRef } from '../../api/group-types.ts';
import type { ReadableKeyedValues } from '../../cache/RepositoryInterfaces.ts';
import { toError } from '../../resilience/to-error.ts';
import type { WebRtcConnectionService } from '../web-rtc-connection-service.ts';
import { WebRtcGroupService } from '../web-rtc-group-service.ts';
import {
    clonePeerOwners,
    emptyGroupPeerLedgerDiagnostics,
    type WebRtcGroupManagerDeleteOptions,
    type WebRtcGroupPeerLedgerDiagnostics,
    type WebRtcPeerOwnership
} from '../webrtc-group-manager-contracts.ts';
import { readOverlayForGroup } from '../webrtc-group-overlay-reading.ts';
import {
    computeConnectionCapSpend,
    type ConnectionCapInboundVerdict,
    type ConnectionCapSpend
} from './compute-connection-cap-spend.ts';
import { RetainedPeerConnections } from './retained-peer-connections.ts';
import {
    selectEarlyOnlyDialPeerIds,
    selectGroupDialPeerIds,
    type SelectGroupDialPeerIdsInput
} from './webrtc-group-dial-policy.ts';

export const DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS = 10;
export const MIN_WEBRTC_MAX_PEER_CONNECTIONS = 5;
export const DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS = 15_000;

/** The connection cap a requested value gives: the default when none is usable, and never below the minimum. */
export function resolveWebRtcMaxPeerConnections(requested: number | undefined): number {
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

export namespace WebRtcGroupPeerLedger {
    export interface Repositories {
        readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;
        readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>;
        readonly plannedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
        readonly acceptedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    }

    export interface Config {
        readonly localSessionId: PeerId;
        readonly repositories: Repositories;
        readonly maxPeerConnections: number;
        readonly overlayTransitionGraceMs: number;
        readonly nowEpochMs: () => number;
    }
}

/**
 * The rooms this browser is in, the peers they want, the connections kept after a room stopped wanting them, and the
 * connection cap over all of them. The connection service's peers reach it as the port each call passes.
 */
export class WebRtcGroupPeerLedger {
    private readonly groupsByKey = new Map<string, WebRtcGroupService>();
    private peerOwnershipCache: WebRtcPeerOwnership | undefined;
    private waitingDialCount = 0;
    private readonly diagnostics = emptyGroupPeerLedgerDiagnostics();

    public readonly localSessionId: PeerId;
    public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;
    public readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>;
    public readonly plannedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    public readonly acceptedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    public readonly maxPeerConnections: number;
    public readonly nowEpochMs: () => number;
    public readonly retainedPeers: RetainedPeerConnections;

    constructor(config: WebRtcGroupPeerLedger.Config) {
        this.localSessionId = config.localSessionId;
        this.groupCache = config.repositories.groupCache;
        this.clientCache = config.repositories.clientCache;
        this.plannedOverlayCache = config.repositories.plannedOverlayCache;
        this.acceptedOverlayCache = config.repositories.acceptedOverlayCache;
        this.maxPeerConnections = config.maxPeerConnections;
        this.nowEpochMs = config.nowEpochMs;
        this.retainedPeers = new RetainedPeerConnections({
            overlayTransitionGraceMs: Math.max(0, config.overlayTransitionGraceMs),
            nowEpochMs: config.nowEpochMs,
            diagnostics: this.diagnostics
        });
    }

    readDiagnostics(): WebRtcGroupPeerLedgerDiagnostics {
        return { ...this.diagnostics };
    }

    resetDiagnostics(): void {
        Object.assign(this.diagnostics, emptyGroupPeerLedgerDiagnostics());
    }

    getOrCreate(group: GroupRef): WebRtcGroupService {
        const groupKey = toWebRtcGroupKey(group);
        let service = this.groupsByKey.get(groupKey);

        if (!service) {
            service = new WebRtcGroupService(
                this.localSessionId,
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

    /** Whether the group or a connection it retains existed. */
    deleteGroup(
        group: GroupRef,
        options: WebRtcGroupManagerDeleteOptions,
        peers: WebRtcConnectionService.AdmissionPeers
    ): boolean {
        const groupKey = toWebRtcGroupKey(group);
        const service = this.groupsByKey.get(groupKey);
        const existed = this.groupsByKey.delete(groupKey);
        const retainedGroupExisted = this.retainedPeers.hasRetainedGroup(groupKey);
        if (!existed && !retainedGroupExisted) {
            return false;
        }

        service?.removeOnStateCallback(
            this.peerOwnersInvalidationCallbackId(groupKey)
        );
        this.invalidatePeerOwners();

        if (options.retainConnections && service) {
            this.retainedPeers.retainKnownPeersForGroup({
                group: service,
                groupKey,
                targetPeerIds: this.targetPeerIdsForGroup(service),
                peers
            });
        }
        else {
            this.retainedPeers.removeRetainedGroup(groupKey);
        }
        return true;
    }

    clear(): void {
        for (const [groupKey, service] of this.groupsByKey.entries()) {
            service.removeOnStateCallback(
                this.peerOwnersInvalidationCallbackId(groupKey)
            );
        }
        this.groupsByKey.clear();
        this.retainedPeers.clear();
        this.invalidatePeerOwners();
    }

    async refreshGroups(): Promise<void> {
        for (const group of this.groupsByKey.values()) {
            await group.refreshFromCache();
        }
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

    readPeerOwnership(): WebRtcPeerOwnership {
        if (!this.peerOwnershipCache) {
            this.peerOwnershipCache = this.computePeerOwnership();
        }

        return this.peerOwnershipCache;
    }

    private computePeerOwnership(): WebRtcPeerOwnership {
        const owners = new Map<PeerId, GroupId[]>();
        const groupKeysByPeerId = new Map<PeerId, string[]>();
        const dialAllowedPeerIds = new Set<PeerId>();
        const selections: SelectGroupDialPeerIdsInput[] = [];
        const maxConcurrentEdgeSetupsByGroupKey = new Map<string, number>();

        for (const group of this.groupsByKey.values()) {
            const snapshot = group.readGroup();
            if (!snapshot) {
                continue;
            }
            maxConcurrentEdgeSetupsByGroupKey.set(group.groupKey, snapshot.group.memberPolicy.maxConcurrentEdgeSetups);
            const groupPresentPeerIds = new Set(group.targetPeerIds());
            const selection = this.toDialSelectionInput(snapshot, group.groupRef);
            selections.push(selection);
            for (const peerId of selectGroupDialPeerIds(selection)) {
                owners.set(peerId, [...(owners.get(peerId) ?? []), group.groupRef.groupId]);
                groupKeysByPeerId.set(peerId, [...(groupKeysByPeerId.get(peerId) ?? []), group.groupKey]);
                if (groupPresentPeerIds.has(peerId)) {
                    dialAllowedPeerIds.add(peerId);
                }
            }
        }

        return {
            groupsByPeerId: owners,
            dialAllowedPeerIds,
            earlyDialPeerIds: selectEarlyOnlyDialPeerIds(selections),
            groupKeysByPeerId,
            maxConcurrentEdgeSetupsByGroupKey
        };
    }

    ownerGroupsOfPeer(peerId: PeerId): readonly GroupId[] {
        const groupIds = this.readPeerOwnership().groupsByPeerId.get(peerId);
        return groupIds ? [...groupIds] : [];
    }

    isPeerDialAllowedByAnyGroup(peerId: PeerId): boolean {
        return this.readPeerOwnership().dialAllowedPeerIds.has(peerId);
    }

    invalidatePeerOwners(): void {
        this.peerOwnershipCache = undefined;
    }

    private peerOwnersInvalidationCallbackId(groupKey: string): string {
        return `webrtc-group-manager:peer-owners:${groupKey}`;
    }

    private targetPeerIdsForGroup(group: WebRtcGroupService): readonly PeerId[] {
        const snapshot = group.readGroup();
        return snapshot ? this.dialPeerIdsForSnapshot(snapshot, group.groupRef) : [];
    }

    private dialPeerIdsForSnapshot(snapshot: AnyGroupPresence, groupRef: GroupRef): readonly PeerId[] {
        return selectGroupDialPeerIds(this.toDialSelectionInput(snapshot, groupRef));
    }

    private toDialSelectionInput(snapshot: AnyGroupPresence, groupRef: GroupRef): SelectGroupDialPeerIdsInput {
        return {
            lifecycleState: snapshot.group.lifecycleState,
            localSessionId: this.localSessionId,
            planned: readOverlayForGroup(this.plannedOverlayCache, groupRef),
            accepted: readOverlayForGroup(this.acceptedOverlayCache, groupRef)
        };
    }

    /** How an offer from a dial-allowed peer would be answered now; it closes nothing. */
    resolveInboundPeer(peerId: PeerId, peers: WebRtcConnectionService.AdmissionPeers): ConnectionCapInboundVerdict {
        return this.computeCapSpend(new Set(peers.knownPeerIds()), peerId, peers).inbound.verdict;
    }

    /** Whether an accepted peer arriving now could take an early peer's slot. */
    hasClosableEarlyPeer(peers: WebRtcConnectionService.AdmissionPeers): boolean {
        return this.computeCapSpend(new Set(peers.knownPeerIds()), null, peers).closableEarlyPeerIds.length > 0;
    }

    /** Answers an offer from a dial-allowed peer; at a full cap it first closes the early peers the ranking names. */
    admitInboundPeer(
        peerId: PeerId,
        peers: WebRtcConnectionService.ClosableAdmissionPeers
    ): ConnectionCapInboundVerdict {
        const { verdict, closePeerIds } = this.computeCapSpend(new Set(peers.knownPeerIds()), peerId, peers).inbound;
        this.closePeersOverCap(closePeerIds, peers);
        return verdict;
    }

    evictPeersOverCap(knownPeerIds: ReadonlySet<PeerId>, peers: WebRtcConnectionService.ClosableAdmissionPeers): void {
        this.closePeersOverCap(this.computeCapSpend(knownPeerIds, null, peers).evictPeerIds, peers);
    }

    /** A desired early peer closed here waits for a free slot like a deferred dial. */
    private closePeersOverCap(peerIds: readonly PeerId[], peers: WebRtcConnectionService.ClosableAdmissionPeers): void {
        for (const peerId of peerIds) {
            try {
                peers.disconnectPeer(peerId, { resetAttemptBudget: false });
                this.recordEvictedOverCap(peerId);
            }
            catch (error) {
                console.error(`Failed to disconnect peer ${peerId} over the connection cap`, toError(error));
            }
        }
    }

    private recordEvictedOverCap(peerId: PeerId): void {
        if (this.retainedPeers.delete(peerId)) {
            this.diagnostics.retainedEvictionCount += 1;
            return;
        }
        this.diagnostics.disconnectCount += 1;
        this.waitingDialCount += 1;
    }

    private computeCapSpend(
        knownPeerIds: ReadonlySet<PeerId>,
        inboundPeerId: PeerId | null,
        peers: WebRtcConnectionService.AdmissionPeers
    ): ConnectionCapSpend {
        const ownership = this.readPeerOwnership();
        return computeConnectionCapSpend({
            maxPeerConnections: this.maxPeerConnections,
            knownPeerIds,
            desiredPeerIds: new Set(ownership.groupsByPeerId.keys()),
            earlyDialPeerIds: ownership.earlyDialPeerIds,
            retainedPeers: Array.from(this.retainedPeers.getRetainedPeerConnections().values()),
            candidatePeerIds: this.readConnectablePeerIds(ownership, peers).filter((peerId) =>
                !knownPeerIds.has(peerId)
            ),
            inboundPeerId
        });
    }

    readConnectablePeerIds(
        ownership: WebRtcPeerOwnership,
        peers: WebRtcConnectionService.AdmissionPeers
    ): readonly PeerId[] {
        const peerIdsWithNoReconnectableLanes = new Set(peers.peerIdsWithNoReconnectableLanes());
        return Array.from(ownership.groupsByPeerId.keys()).filter(
            (peerId) => ownership.dialAllowedPeerIds.has(peerId) && !peerIdsWithNoReconnectableLanes.has(peerId)
        );
    }

    /** Dials deferred or paced by the last pass, and desired early peers closed over the cap since. */
    getWaitingDialCount(): number {
        return this.waitingDialCount;
    }

    setWaitingDialCount(waitingDialCount: number): void {
        this.waitingDialCount = waitingDialCount;
    }
}
