import type { ALMessage } from '../../al-contracts/al-contract.ts';

/**
 * A granted room unicast is carried as the one-entry listed broadcast of its room, which its origin freezes as a
 * multicast of one; every other message, a unicast naming no room included, is the same reference.
 */
export function toRtcGrantedListedLeg(msg: ALMessage): ALMessage {
    const targets = msg.targets;
    if (targets?.mode !== 'unicast' || targets.groupRef === undefined) {
        return msg;
    }
    return {
        ...msg,
        targets: { mode: 'broadcast', scope: 'room', groupRef: targets.groupRef, recipientPeerIds: [targets.toPeerId] }
    };
}
