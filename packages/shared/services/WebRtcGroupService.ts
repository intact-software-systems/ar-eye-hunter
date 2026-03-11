import { WebRtcConnectionService } from './WebRtcConnectionService.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import {
    type AnyGroupPresence,
    readGroupId,
    readGroupMemberSessionIds,
    readGroupVersion,
} from '../api/group-client-views.ts';

type PeerId = string;
type GroupUpdateSource = 'push' | 'pull';

export type GroupMembershipDiff = {
    readonly joinedPeerIds: readonly PeerId[];
    readonly leftPeerIds: readonly PeerId[];
};

export type WebRtcGroupServiceState = {
    readonly groupId: string;
    readonly snapshot: AnyGroupPresence | undefined;
    readonly targetPeerIds: readonly PeerId[];
};

export class WebRtcGroupService {
    private snapshot: AnyGroupPresence | undefined;

    private readonly onStateCallbacks = new Map<
        string,
        (
            state: WebRtcGroupServiceState,
            diff: GroupMembershipDiff,
            source: GroupUpdateSource,
        ) => Promise<void>
    >();

    constructor(
        public readonly rtcQBox: WebRtcConnectionService,
        public readonly groupId: string,
        public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>,
    ) {
    }

    onStateDo(
        id: string,
        callback: (
            state: WebRtcGroupServiceState,
            diff: GroupMembershipDiff,
            source: GroupUpdateSource,
        ) => Promise<void>,
    ): WebRtcGroupService {
        this.onStateCallbacks.set(id, callback);
        return this;
    }

    removeOnStateCallback(id: string): boolean {
        return this.onStateCallbacks.delete(id);
    }

    readGroup(): AnyGroupPresence | undefined {
        return this.snapshot ?? this.groupCache.read(this.groupId);
    }

    peekGroup(): AnyGroupPresence | undefined {
        return this.snapshot ?? this.groupCache.peek(this.groupId);
    }

    targetPeerIds(): readonly PeerId[] {
        return this.computeTargetPeerIds(this.readGroup());
    }

    state(): WebRtcGroupServiceState {
        const snapshot = this.readGroup();
        return {
            groupId: this.groupId,
            snapshot,
            targetPeerIds: this.computeTargetPeerIds(snapshot),
        };
    }

    async acceptGroupUpdate(snapshot: AnyGroupPresence): Promise<GroupMembershipDiff> {
        if (readGroupId(snapshot) !== this.groupId) {
            throw new Error(
                `Received update for wrong room ${readGroupId(snapshot)}, expected ${this.groupId}`,
            );
        }

        const before = this.computeTargetPeerIds(this.readGroup());

        const currentVersion = this.snapshot ? readGroupVersion(this.snapshot) : -1;
        const incomingVersion = readGroupVersion(snapshot);
        if (incomingVersion < currentVersion) {
            console.warn(
                `Ignoring stale group snapshot for ${readGroupId(snapshot)}. ` +
                `Incoming version=${incomingVersion}, current=${currentVersion}`,
            );
            return {
                joinedPeerIds: [],
                leftPeerIds: [],
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

        this.snapshot = this.groupCache.read(this.groupId) ??
            this.groupCache.peek(this.groupId);

        const after = this.computeTargetPeerIds(this.readGroup());
        const diff = this.computeDiff(before, after);

        await this.notify(diff, 'pull');
        return diff;
    }

    private async notify(
        diff: GroupMembershipDiff,
        source: GroupUpdateSource,
    ): Promise<void> {
        const state = this.state();

        for (const callback of this.onStateCallbacks.values()) {
            try {
                await callback(state, diff, source);
            } catch (error) {
                console.error('Error in WebRtcGroupService callback', error);
            }
        }
    }

    private computeTargetPeerIds(snapshot: AnyGroupPresence | undefined): readonly PeerId[] {
        if (!snapshot) {
            return [];
        }

        return readGroupMemberSessionIds(snapshot).filter(
            (peerId) => peerId !== this.rtcQBox.input.sessionId,
        );
    }

    private computeDiff(
        before: readonly PeerId[],
        after: readonly PeerId[],
    ): GroupMembershipDiff {
        const beforeSet = new Set(before);
        const afterSet = new Set(after);

        return {
            joinedPeerIds: after.filter((peerId) => !beforeSet.has(peerId)),
            leftPeerIds: before.filter((peerId) => !afterSet.has(peerId)),
        };
    }
}
