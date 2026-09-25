import type { ALMessage, ALTargets } from './al-contract.ts';

/** The logical recipients a room multicast was admitted for, and the room snapshot version they were read at. */
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
 * or changes a frozen audience still differs.
 */
export function toALFreezeComparableMessage(original: ALMessage, candidate: ALMessage): ALMessage {
    const frozen = resolveALFrozenMulticastAudience(candidate.targets);
    if (
        frozen === undefined || candidate.targets?.mode !== 'multicast' || original.targets?.mode !== 'multicast' ||
        original.targets.recipientPeerIds !== undefined || original.targets.snapshotVersion !== undefined
    ) {
        return candidate;
    }
    const { recipientPeerIds: _recipientPeerIds, snapshotVersion: _snapshotVersion, ...targets } = candidate.targets;
    return { ...candidate, targets };
}

/**
 * The sessions an admission stamps as a room message's audience: every authorized session, narrowed to a
 * multicast's frozen recipients when it carries them. A frozen audience can narrow, never widen, what the
 * admitting authority allows.
 */
export function resolveALAdmittedRoomAudience(
    targets: ALTargets | undefined,
    authorizedPeerIds: readonly string[]
): readonly string[] {
    const frozen = resolveALFrozenMulticastAudience(targets);
    return frozen === undefined
        ? authorizedPeerIds
        : authorizedPeerIds.filter((peerId) => frozen.recipientPeerIds.includes(peerId));
}
