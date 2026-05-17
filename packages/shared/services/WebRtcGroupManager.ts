import { WebRtcConnectionService } from './WebRtcConnectionService.ts';
import { WebRtcGroupService } from './WebRtcGroupService.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { GroupId, PeerId } from '../api/api-config.ts';
import {
    type AnyClientPresence,
    type AnyGroupPresence,
    readActiveClientSessionIds,
} from '../api/group-client-views.ts';

export type WebRtcGroupManagerState = {
    readonly groupIds: readonly GroupId[];
    readonly desiredPeerIds: readonly PeerId[];
    readonly onlinePeerIds: readonly PeerId[];
    readonly onlineDesiredPeerIds: readonly PeerId[];
    readonly connectablePeerIds: readonly PeerId[];
    readonly peerIdsWithNoReconnectableLanes: readonly PeerId[];
    /** @deprecated Use peerIdsWithNoReconnectableLanes. */
    readonly connectedPeerIds: readonly PeerId[];
    readonly peerOwners: ReadonlyMap<PeerId, readonly GroupId[]>;
};

export class WebRtcGroupManager {
    private readonly groupsById = new Map<GroupId, WebRtcGroupService>();
    private reconcileInFlight: Promise<void> | undefined;

    constructor(
        public readonly rtcQBox: WebRtcConnectionService,
        public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>,
        public readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>,
    ) {
    }

    getOrCreate(groupId: GroupId): WebRtcGroupService {
        let group = this.groupsById.get(groupId);

        if (!group) {
            group = new WebRtcGroupService(
                this.rtcQBox,
                groupId,
                this.groupCache,
            );
            this.groupsById.set(groupId, group);
        }

        return group;
    }

    getIfPresent(groupId: GroupId): WebRtcGroupService | undefined {
        return this.groupsById.get(groupId);
    }

    has(groupId: GroupId): boolean {
        return this.groupsById.has(groupId);
    }

    async delete(groupId: GroupId): Promise<boolean> {
        const existed = this.groupsById.delete(groupId);
        if (!existed) {
            return false;
        }

        await this.reconcileAllGroups();
        return true;
    }

    async clear(): Promise<void> {
        this.groupsById.clear();
        await this.reconcileAllGroups();
    }

    size(): number {
        return this.groupsById.size;
    }

    groupIds(): readonly GroupId[] {
        return Array.from(this.groupsById.keys());
    }

    groups(): readonly WebRtcGroupService[] {
        return Array.from(this.groupsById.values());
    }

    /**
     * Returns peer -> owning groups.
     */
    peerOwners(): ReadonlyMap<PeerId, readonly GroupId[]> {
        const owners = new Map<PeerId, GroupId[]>();

        for (const [groupId, group] of this.groupsById.entries()) {
            for (const peerId of group.targetPeerIds()) {
                let groupIds = owners.get(peerId);
                if (!groupIds) {
                    groupIds = [];
                    owners.set(peerId, groupIds);
                }
                groupIds.push(groupId);
            }
        }

        const readonlyOwners = new Map<PeerId, readonly GroupId[]>();
        for (const [peerId, groupIds] of owners.entries()) {
            readonlyOwners.set(peerId, [...groupIds]);
        }

        return readonlyOwners;
    }

    ownerGroupsOfPeer(peerId: PeerId): readonly GroupId[] {
        return this.peerOwners().get(peerId) ?? [];
    }

    isPeerOwnedByAnyGroup(peerId: PeerId): boolean {
        return this.peerOwners().has(peerId);
    }

    state(): WebRtcGroupManagerState {
        const peerOwners = this.peerOwners();
        const desiredPeerIds = Array.from(peerOwners.keys());
        const onlinePeerIds = Array.from(this.onlinePeerIds());
        const onlineDesiredPeerIds = desiredPeerIds.filter((peerId) =>
            this.onlinePeerIds().has(peerId)
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
            connectedPeerIds: peerIdsWithNoReconnectableLanes,
            peerOwners,
        };
    }

    async acceptGroupUpdate(
        snapshot: AnyGroupPresence,
    ): Promise<WebRtcGroupService> {
        const groupId = snapshot.group.groupId;
        const group = this.getOrCreate(groupId);
        await group.acceptGroupUpdate(snapshot);
        await this.reconcileAllGroups();
        return group;
    }

    async refreshGroup(groupId: GroupId): Promise<WebRtcGroupService> {
        const group = this.getOrCreate(groupId);
        await group.refreshFromCache();
        await this.reconcileAllGroups();
        return group;
    }

    async refreshAllGroups(): Promise<void> {
        for (const group of this.groupsById.values()) {
            await group.refreshFromCache();
        }

        await this.reconcileAllGroups();
    }

    async ensureAllGroupsConnected(): Promise<void> {
        await this.reconcileAllGroups();
    }

    async ensureGroupConnected(groupId: GroupId): Promise<WebRtcGroupService> {
        const group = this.getOrCreate(groupId);
        await this.reconcileAllGroups();
        return group;
    }

    private async reconcileAllGroups(): Promise<void> {
        if (this.reconcileInFlight) {
            await this.reconcileInFlight;
            return;
        }

        const run = (async () => {
            const peerOwners = this.peerOwners();
            const desiredPeerIds = new Set(peerOwners.keys());
            const onlinePeerIds = this.onlinePeerIds();
            const peerIdsWithNoReconnectableLanes = new Set(
                this.rtcQBox.peerIdsWithNoReconnectableLanes(),
            );
            const knownPeerIds = new Set(this.rtcQBox.knownPeerIds());

            const connectablePeerIds = Array.from(desiredPeerIds).filter(
                (peerId) => onlinePeerIds.has(peerId),
            );

            const peersToConnect = connectablePeerIds.filter(
                (peerId) => !peerIdsWithNoReconnectableLanes.has(peerId),
            );

            const peersToDisconnect = Array.from(knownPeerIds).filter(
                (peerId) => !desiredPeerIds.has(peerId),
            );

            for (const peerId of peersToConnect) {
                const connected = this.rtcQBox.ensurePeerConnectionStarted(peerId);
                if (connected.left) {
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

            for (const peerId of peersToDisconnect) {
                try {
                    this.rtcQBox.disconnectPeer(peerId);
                } catch (error) {
                    console.error(`Failed to disconnect peer ${peerId}`, error);
                }
            }
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
}
