import { isSameGroupRef } from '../api/api-type-utils.ts';
import { jsonEquals } from '../repository/state-utils.ts';
import { isALLeaderRoomBroadcast } from './al-audience-narrowing.ts';
import type { ALMessage, ALTargets } from './al-contract.ts';

export interface ALFrozenMulticastAudience {
    readonly recipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
}

export function resolveALFrozenMulticastAudience(
    targets: ALTargets | undefined
): ALFrozenMulticastAudience | undefined {
    if (
        targets?.mode !== 'multicast' || targets.recipientPeerIds === undefined || targets.snapshotVersion === undefined
    ) {
        return undefined;
    }
    return { recipientPeerIds: targets.recipientPeerIds, snapshotVersion: targets.snapshotVersion };
}

export function toALFrozenMulticastMessage(message: ALMessage, audience: ALFrozenMulticastAudience): ALMessage {
    if (message.targets?.mode !== 'multicast') {
        return message;
    }
    return {
        ...message,
        targets: {
            ...message.targets,
            recipientPeerIds: audience.recipientPeerIds,
            snapshotVersion: audience.snapshotVersion
        }
    };
}

/**
 * The candidate as the original would compare to it. Freezing an unfrozen multicast's audience is the one
 * change a planned or stored copy may add to its original, so that change alone is removed; a copy that drops
 * or changes a frozen audience still differs. A principal or listed room broadcast, or a room broadcast to its
 * leader, is frozen as the multicast of its room, floors and narrowed audience: a frozen copy of that room within the
 * list compares as its original.
 */
export function toALFreezeComparableMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    const frozen = resolveALFrozenMulticastAudience(candidate.targets);
    if (frozen === undefined || candidate.targets?.mode !== 'multicast') {
        return candidate;
    }
    if (original.targets?.mode === 'broadcast') {
        const freeze = {
            original: original.targets,
            addressesLeader: isALLeaderRoomBroadcast(original),
            frozenTargets: candidate.targets,
            frozen
        };
        return isALNarrowedBroadcastFrozenAs(freeze) ? { ...candidate, targets: original.targets } : candidate;
    }
    if (
        original.targets?.mode !== 'multicast' || original.targets.recipientPeerIds !== undefined ||
        original.targets.snapshotVersion !== undefined
    ) {
        return candidate;
    }
    const { recipientPeerIds: _recipientPeerIds, snapshotVersion: _snapshotVersion, ...targets } = candidate.targets;
    return { ...candidate, targets };
}

/**
 * Whether a candidate freezes the audience of an original held without one: a room send admitted before its room
 * authority was observed is frozen by the plan that first reads it, and that plan's copy replaces the held row.
 */
export function isALFreezeOfMessage(original: ALMessage, candidate: ALMessage): boolean {
    return resolveALFrozenMulticastAudience(original.targets) === undefined &&
        resolveALFrozenMulticastAudience(candidate.targets) !== undefined &&
        jsonEquals(original, toALFreezeComparableMessage(original, candidate));
}

/**
 * The sessions an admission stamps as a room message's delivery audience: every authorized session, narrowed to a
 * multicast's frozen recipients when it carries them. A frozen audience can narrow, never widen, whom the message is
 * delivered to. The WS server's receipt aggregate is the one reader that may expect more: it keeps a frozen audience
 * verbatim, so a frozen recipient the authority no longer admits reads unconfirmed (S3c-i C11). The origin stays in
 * it, as it does in an unfrozen audience, so a narrowed audience is never empty: every consumer already excludes the
 * origin, and the handling policy reads an empty member set as unrestricted.
 */
export function resolveALAdmittedRoomAudience(
    message: ALMessage,
    authorizedPeerIds: readonly string[]
): readonly string[] {
    const frozen = resolveALFrozenMulticastAudience(message.targets);
    return frozen === undefined
        ? authorizedPeerIds
        : authorizedPeerIds.filter((peerId) =>
            peerId === message.id.senderId || frozen.recipientPeerIds.includes(peerId)
        );
}

/** A broadcast that names its own audience, and the multicast a candidate froze it as. */
interface ALNarrowedBroadcastFreeze {
    readonly original: Extract<ALTargets, { readonly mode: 'broadcast'; }>;
    /** The original addresses its room's leader, which narrows a room broadcast as a list does. */
    readonly addressesLeader: boolean;
    readonly frozenTargets: Extract<ALTargets, { readonly mode: 'multicast'; }>;
    readonly frozen: ALFrozenMulticastAudience;
}

function isALNarrowedBroadcastFrozenAs(
    { original, addressesLeader, frozenTargets, frozen }: ALNarrowedBroadcastFreeze
): boolean {
    const narrowed = (original.scope === 'principal' && original.principalRef !== undefined) ||
        (original.scope === 'room' && original.recipientPeerIds !== undefined) || addressesLeader;
    const listed = original.recipientPeerIds;
    return narrowed && original.groupRef !== undefined &&
        isSameGroupRef(original.groupRef, frozenTargets.groupRef) &&
        original.minSnapshotVersion === frozenTargets.minSnapshotVersion &&
        original.rosterVersion === frozenTargets.rosterVersion &&
        frozen.recipientPeerIds.every((peerId) =>
            !original.exceptPeerIds?.includes(peerId) && (listed === undefined || listed.includes(peerId))
        );
}
