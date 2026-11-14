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
import { WebRtcGroupService } from '../web-rtc-group-service.ts';
import {
    clonePeerOwners,
    type WebRtcGroupManagerDeleteOptions,
    type WebRtcPeerOwnership
} from '../webrtc-group-manager-contracts.ts';
import { readOverlayForGroup } from '../webrtc-group-overlay-reading.ts';
import {
    selectEarlyOnlyDialPeerIds,
    selectGroupDialPeerIds,
    type SelectGroupDialPeerIdsInput
} from './webrtc-group-dial-policy.ts';

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
    }

    /** The retained connections a deleted group's peers keep or lose; their owner passes them with the call. */
    export interface GroupRetention {
        hasRetainedGroup(groupKey: string): boolean;
        retainKnownPeersForGroup(group: WebRtcGroupService, groupKey: string): void;
        removeRetainedGroup(groupKey: string): void;
    }
}

/** The rooms this browser is in and the peers they want, computed lazily from each room's snapshot and layouts. */
export class WebRtcGroupPeerLedger {
    private readonly groupsByKey = new Map<string, WebRtcGroupService>();
    private peerOwnershipCache: WebRtcPeerOwnership | undefined;

    public readonly localSessionId: PeerId;
    public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;
    public readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>;
    public readonly plannedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;
    public readonly acceptedOverlayCache?: ReadableKeyedValues<string, OverlayInfo>;

    constructor(config: WebRtcGroupPeerLedger.Config) {
        this.localSessionId = config.localSessionId;
        this.groupCache = config.repositories.groupCache;
        this.clientCache = config.repositories.clientCache;
        this.plannedOverlayCache = config.repositories.plannedOverlayCache;
        this.acceptedOverlayCache = config.repositories.acceptedOverlayCache;
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

    /** Whether the group or a connection it retains existed; the retained connections are the caller's. */
    deleteGroup(
        group: GroupRef,
        options: WebRtcGroupManagerDeleteOptions,
        retention: WebRtcGroupPeerLedger.GroupRetention
    ): boolean {
        const groupKey = toWebRtcGroupKey(group);
        const service = this.groupsByKey.get(groupKey);
        const existed = this.groupsByKey.delete(groupKey);
        const retainedGroupExisted = retention.hasRetainedGroup(groupKey);
        if (!existed && !retainedGroupExisted) {
            return false;
        }

        service?.removeOnStateCallback(
            this.peerOwnersInvalidationCallbackId(groupKey)
        );
        this.invalidatePeerOwners();

        if (options.retainConnections && service) {
            retention.retainKnownPeersForGroup(service, groupKey);
        }
        else {
            retention.removeRetainedGroup(groupKey);
        }
        return true;
    }

    clearGroups(): void {
        for (const [groupKey, service] of this.groupsByKey.entries()) {
            service.removeOnStateCallback(
                this.peerOwnersInvalidationCallbackId(groupKey)
            );
        }
        this.groupsByKey.clear();
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

    targetPeerIdsForGroup(group: WebRtcGroupService): readonly PeerId[] {
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
}
