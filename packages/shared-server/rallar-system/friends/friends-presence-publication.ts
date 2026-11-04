import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RuntimeStateGuardedBatchGuard } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { ClientMutationCommand, ClientMutationRead } from '../client-state/mutation/client-mutation-contracts.ts';
import { computeClientPresenceTransition } from '../client-state/mutation/client-presence-transition.ts';
import { isClientSnapshotSessionLive } from '../presence/snapshot-presence.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '../websocket/outbox/compute-view-invalidation-publication.ts';
import {
    computeGuardedViewPublication,
    type GuardedViewPublication
} from '../websocket/outbox/guarded-view-publication.ts';
import type { FriendsProfileRead } from './friends-mutation-contracts.ts';
import {
    areMutualFriends,
    FRIENDS_PROFILE_NAMESPACE,
    friendsProfileKey
} from './friends-profile.ts';
import { decodeFriendsProfileRead, type FriendsRepository } from './friends-repository.ts';

export interface FriendsPresenceRead {
    readonly own: FriendsProfileRead;
    readonly peers: readonly FriendsProfileRead[];
}

/** Friendship is account-wide; presence is read and notified only inside the caller's game/workspace. */
export async function readFriendsPresence(
    profiles: FriendsRepository,
    own: FriendsProfileRead
): Promise<FriendsPresenceRead> {
    const peers = own.profile.shareOnline
        ? await profiles.readProfiles(
            own.profile.contacts.filter((contact) => contact.status === 'friend').map((contact) => contact.principalId)
        )
        : [];
    return { own, peers };
}

export function isFriendOnline(snapshot: ClientSnapshot | null | undefined, atEpochMs: number): boolean {
    return snapshot?.activeSessions.some((session) => isClientSnapshotSessionLive(session, atEpochMs)) === true;
}

export function computeFriendsPresencePublication(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    snapshot: ClientSnapshot
): GuardedViewPublication | null {
    const presence = read.friendsPresence;
    if (presence === null) {
        return null;
    }
    const transition = computeClientPresenceTransition(command, read, snapshot);
    if (
        isFriendOnline(transition.before, transition.beforeAtEpochMs) ===
            isFriendOnline(snapshot, transition.afterAtEpochMs)
    ) {
        return null;
    }
    const peers = presence.own.profile.shareOnline
        ? presence.peers.filter(({ profile }) => areMutualFriends(presence.own.profile, profile))
        : [];
    const publication = computeViewInvalidationPublication({
        resource: 'friends',
        scope: { applicationId: command.aggregateRef.applicationId, workspaceId: command.aggregateRef.workspaceId },
        principalIds: peers.map(({ profile }) => profile.principalId),
        changeId: computeSha256CanonicalJson({
            principal: command.aggregateRef,
            commandId: command.commandId,
            stateRevision: snapshot.stateRevision
        }),
        createdAtEpochMs: command.facts.nowEpochMs,
        retentionMs: command.facts.expireAtEpochMs - command.facts.nowEpochMs,
        serviceId: command.facts.serviceId,
        traceId: command.facts.traceId
    });
    // Even hidden/absent profiles fence a concurrent visibility change or friendship acceptance.
    return computeGuardedViewPublication({
        guard: profileGuard(presence.own),
        effects: [
            ...peers.map((peer) => ({ ...profileGuard(peer), effectId: `friend:${peer.profile.principalId}` })),
            ...publication.provenance
        ]
    }, publication.outbox);
}

function profileGuard(read: FriendsProfileRead): RuntimeStateGuardedBatchGuard {
    const value = {
        namespace: FRIENDS_PROFILE_NAMESPACE,
        key: friendsProfileKey(read.profile.principalId),
        value: JSON.stringify(read.profile),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    return read.entry === null
        ? { ...value, operation: 'insert' }
        : { ...value, operation: 'update', expectedRevision: read.entry.revision };
}

export function assertFriendsPresenceRead(principalId: string, read: FriendsPresenceRead | null): void {
    if (read === null) {
        return;
    }
    if (!jsonEquals(read.own, decodeFriendsProfileRead(principalId, read.own.entry ?? undefined))) {
        throw new TypeError('Friends presence differs from its captured own profile');
    }
    const expected = read.own.profile.shareOnline
        ? read.own.profile.contacts.filter((contact) => contact.status === 'friend').map((contact) =>
            contact.principalId
        ).sort()
        : [];
    if (!jsonEquals(read.peers.map(({ profile }) => profile.principalId).sort(), expected)) {
        throw new TypeError('Friends presence differs from its complete consent audience');
    }
    for (const peer of read.peers) {
        if (!jsonEquals(peer, decodeFriendsProfileRead(peer.profile.principalId, peer.entry ?? undefined))) {
            throw new TypeError('Friends presence differs from its captured peer profile');
        }
    }
}
