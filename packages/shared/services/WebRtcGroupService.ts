import { isSameGroupScope, toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import {
    readGroupId,
    readGroupMemberSessionIds,
    readGroupVersion,
    type AnyGroupPresence
} from '../api/group-client-views.ts';
import type { GroupRef } from '../api/group-types.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { WebRtcConnectionService } from './WebRtcConnectionService.ts';

type PeerId = string;
type GroupUpdateSource = 'push' | 'pull';

export type GroupMembershipDiff = {
    readonly joinedPeerIds: readonly PeerId[];
    readonly leftPeerIds: readonly PeerId[];
};

export type WebRtcGroupServiceState = {
    readonly groupRef: GroupRef;
    readonly snapshot: AnyGroupPresence | undefined;
    readonly targetPeerIds: readonly PeerId[];
};

export class WebRtcGroupService {
    private snapshot: AnyGroupPresence | undefined;
    public readonly groupKey: string;

    private readonly onStateCallbacks = new Map<
        string,
        (
            state: WebRtcGroupServiceState,
            diff: GroupMembershipDiff,
            source: GroupUpdateSource
        ) => Promise<void>
    >();

    public readonly rtcQBox: WebRtcConnectionService;
    public readonly groupRef: GroupRef;
    public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>;

    constructor(
        rtcQBox: WebRtcConnectionService,
        groupRef: GroupRef,
        groupCache: ReadableKeyedValues<string, AnyGroupPresence>
    ) {
        this.rtcQBox = rtcQBox;
        this.groupRef = groupRef;
        this.groupCache = groupCache;
        this.groupKey = toWebRtcGroupKey(groupRef);
    }

    onStateDo(
        id: string,
        callback: (
            state: WebRtcGroupServiceState,
            diff: GroupMembershipDiff,
            source: GroupUpdateSource
        ) => Promise<void>
    ): WebRtcGroupService {
        this.onStateCallbacks.set(id, callback);
        return this;
    }

    removeOnStateCallback(id: string): boolean {
        return this.onStateCallbacks.delete(id);
    }

    readGroup(): AnyGroupPresence | undefined {
        return this.snapshot ?? this.readCachedGroup('read');
    }

    peekGroup(): AnyGroupPresence | undefined {
        return this.snapshot ?? this.readCachedGroup('peek');
    }

    targetPeerIds(): readonly PeerId[] {
        return this.computeTargetPeerIds(this.readGroup());
    }

    state(): WebRtcGroupServiceState {
        const snapshot = this.readGroup();
        return {
            groupRef: this.groupRef,
            snapshot,
            targetPeerIds: this.computeTargetPeerIds(snapshot)
        };
    }

    async acceptGroupUpdate(snapshot: AnyGroupPresence): Promise<GroupMembershipDiff> {
        if (
            readGroupId(snapshot) !== this.groupRef.groupId ||
            !isSameGroupScope(snapshot.group, this.groupRef)
        ) {
            throw new Error(
                `Received update for wrong room ${readGroupId(snapshot)}, expected ${this.groupRef.groupId}`
            );
        }

        const before = this.computeTargetPeerIds(this.readGroup());

        const currentVersion = this.snapshot ? readGroupVersion(this.snapshot) : -1;
        const incomingVersion = readGroupVersion(snapshot);
        if (incomingVersion < currentVersion) {
            console.warn(
                `Ignoring stale group snapshot for ${readGroupId(snapshot)}. ` +
                    `Incoming version=${incomingVersion}, current=${currentVersion}`
            );
            return {
                joinedPeerIds: [],
                leftPeerIds: []
            };
        }

        this.snapshot = snapshot;

        const after = this.computeTargetPeerIds(this.readGroup());
        const diff = this.computeDiff(before, after);

        await this.notify(diff, 'push');
        return diff;
    }

    async refreshFromCache(): Promise<GroupMembershipDiff> {
        const before = this.computeTargetPeerIds(this.readGroup());

        this.snapshot = this.readCachedGroup('read') ??
            this.readCachedGroup('peek');

        const after = this.computeTargetPeerIds(this.readGroup());
        const diff = this.computeDiff(before, after);

        await this.notify(diff, 'pull');
        return diff;
    }

    private async notify(
        diff: GroupMembershipDiff,
        source: GroupUpdateSource
    ): Promise<void> {
        const state = this.state();

        for (const callback of this.onStateCallbacks.values()) {
            try {
                await callback(state, diff, source);
            }
            catch (error) {
                console.error('Error in WebRtcGroupService callback', error);
            }
        }
    }

    private computeTargetPeerIds(snapshot: AnyGroupPresence | undefined): readonly PeerId[] {
        if (!snapshot) {
            return [];
        }

        return readGroupMemberSessionIds(snapshot).filter(
            (peerId) => peerId !== this.rtcQBox.input.sessionId
        );
    }

    private readCachedGroup(mode: 'read' | 'peek'): AnyGroupPresence | undefined {
        const direct = this.readDirectCachedGroup(mode, this.groupKey);
        if (direct) {
            return direct;
        }

        if (typeof this.groupCache.readAllValues !== 'function') {
            return undefined;
        }

        return this.findLatestMatchingCachedGroup(this.groupCache.readAllValues());
    }

    private readDirectCachedGroup(
        mode: 'read' | 'peek',
        key: string
    ): AnyGroupPresence | undefined {
        return mode === 'read'
            ? this.groupCache.read(key)
            : this.groupCache.peek(key);
    }

    private findLatestMatchingCachedGroup(
        snapshots: readonly AnyGroupPresence[]
    ): AnyGroupPresence | undefined {
        let latest: AnyGroupPresence | undefined;
        let latestVersion = Number.NEGATIVE_INFINITY;

        for (const snapshot of snapshots) {
            if (
                readGroupId(snapshot) !== this.groupRef.groupId ||
                !isSameGroupScope(snapshot.group, this.groupRef)
            ) {
                continue;
            }

            const version = readGroupVersion(snapshot);
            if (version > latestVersion) {
                latest = snapshot;
                latestVersion = version;
            }
        }

        return latest;
    }

    private computeDiff(
        before: readonly PeerId[],
        after: readonly PeerId[]
    ): GroupMembershipDiff {
        const beforeSet = new Set(before);
        const afterSet = new Set(after);

        return {
            joinedPeerIds: after.filter((peerId) => !beforeSet.has(peerId)),
            leftPeerIds: before.filter((peerId) => !afterSet.has(peerId))
        };
    }
}
