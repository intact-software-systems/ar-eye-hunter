import type { ALMessage } from '../al-contract.ts';

/**
 * The application stream a live publication belongs to (D467). Every identity field joins the JSON tuple,
 * absent fields as `null`, so absent values and delimiter look-alikes never collide. The stage keys a
 * message before admission, when `recipientPeerIds` on a multicast is still the sender's own fixed list (A1);
 * the RTC origin writes the frozen audience and `snapshotVersion` only when it plans the message.
 */
export function toALPublicationStreamKey(msg: ALMessage): string {
    const targets = msg.targets;
    const groupRef = targets !== undefined && 'groupRef' in targets ? targets.groupRef : undefined;
    const broadcast = targets?.mode === 'broadcast' ? targets : undefined;
    const recipientPeerIds = targets?.mode === 'unicast' ? undefined : targets?.recipientPeerIds;
    const principalRef = broadcast?.principalRef;
    const exceptPeerIds = broadcast?.exceptPeerIds;

    return JSON.stringify([
        msg.id.senderId,
        targets?.mode ?? null,
        groupRef?.applicationId ?? null,
        groupRef?.workspaceId ?? null,
        groupRef?.groupId ?? null,
        broadcast?.scope ?? null,
        principalRef === undefined
            ? null
            : [principalRef.applicationId, principalRef.workspaceId, principalRef.principalId],
        targets?.mode === 'unicast' ? targets.toPeerId : null,
        recipientPeerIds === undefined ? null : [...recipientPeerIds].sort(),
        exceptPeerIds === undefined ? null : [...exceptPeerIds].sort(),
        msg.route.topicId,
        msg.route.contextId,
        msg.payload.typeId,
        msg.route.resourceId
    ]);
}

/** A live channel is one lane: its topic and message type (D467). */
export function toALPublicationLaneKey(msg: ALMessage): string {
    return `${msg.route.topicId}/${msg.payload.typeId}`;
}
