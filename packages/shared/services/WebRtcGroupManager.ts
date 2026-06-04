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
import { toScopedOverlayId, toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';

export type WebRtcGroupManagerState = {
    readonly groupIds: readonly GroupId[];
    readonly desiredPeerIds: readonly PeerId[];
    readonly onlinePeerIds: readonly PeerId[];
    readonly onlineDesiredPeerIds: readonly PeerId[];
    readonly connectablePeerIds: readonly PeerId[];
    readonly peerIdsWithNoReconnectableLanes: readonly PeerId[];
    readonly peerOwners: ReadonlyMap<PeerId, readonly GroupId[]>;
};

export class WebRtcGroupManager {
    private readonly groupsByKey = new Map<string, WebRtcGroupService>();
    private reconcileInFlight: Promise<void> | undefined;

    constructor(
        public readonly rtcQBox: WebRtcConnectionService,
        public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>,
        public readonly clientCache: ReadableKeyedValues<string, AnyClientPresence>,
        public readonly overlayCache?: ReadableKeyedValues<string, OverlayInfo>,
    ) {
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

    async delete(group: GroupRef): Promise<boolean> {
        const groupKey = toWebRtcGroupKey(group);
        const existed = this.groupsByKey.delete(groupKey);
        if (!existed) {
            return false;
        }

        await this.reconcileAllGroups();
        return true;
    }

    async clear(): Promise<void> {
        this.groupsByKey.clear();
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
            peerOwners,
        };
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

    notifyOverlayTopologyChanged(): Promise<void> {
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

    private targetPeerIdsForGroup(group: WebRtcGroupService): readonly PeerId[] {
        const overlay = this.readOverlayForGroup(group.groupRef);
        if (overlay) {
            return overlay.nextHopSessionIds.filter(
                (peerId) => peerId !== this.rtcQBox.input.sessionId,
            );
        }

        return group.targetPeerIds();
    }

    private readOverlayForGroup(groupRef: GroupRef): OverlayInfo | undefined {
        if (!this.overlayCache) {
            return undefined;
        }

        const scopedOverlayId = toScopedOverlayId(groupRef);
        return this.overlayCache.read(scopedOverlayId) ??
            this.overlayCache.peek(scopedOverlayId) ??
            this.overlayCache.read(groupRef.groupId) ??
            this.overlayCache.peek(groupRef.groupId);
    }
}
