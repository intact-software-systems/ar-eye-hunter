import type { ALMessage } from '../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../al-contracts/al-frozen-multicast-audience.ts';

/**
 * A refusal names the targets its sender gave: an audience this plan froze is undone, one its sender gave frozen -- a
 * signed stored copy's -- is kept.
 */
export function toUnfrozenRoomMessage(msg: ALMessage, original: ALMessage): ALMessage {
    if (resolveALFrozenMulticastAudience(original.targets) !== undefined) {
        return msg;
    }
    return original.targets?.mode === 'broadcast'
        ? { ...msg, targets: original.targets }
        : toUnfrozenMulticastMessage(msg);
}

function toUnfrozenMulticastMessage(msg: ALMessage): ALMessage {
    if (msg.targets?.mode !== 'multicast') {
        return msg;
    }
    const { recipientPeerIds, snapshotVersion, ...targets } = msg.targets;
    return recipientPeerIds === undefined && snapshotVersion === undefined ? msg : { ...msg, targets };
}
