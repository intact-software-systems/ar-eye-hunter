import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALFrozenMulticastAudience } from '../../al-contracts/al-frozen-multicast-audience.ts';
import type { ALAckAlgo } from '../../al-contracts/al-policy.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';

/** The sessions a receiver or leader receipt counts: the frozen audience, or a unicast's addressee; undefined under any other mode or before the freeze. */
export function resolveALCountedRecipientPeerIds(msg: ALMessage, algo: ALAckAlgo): readonly string[] | undefined {
    if (!isALLogicalReceiptMode(algo)) {
        return undefined;
    }
    return msg.targets?.mode === 'unicast'
        ? [msg.targets.toPeerId]
        : resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds;
}

export function isALCountedRecipient(msg: ALMessage, algo: ALAckAlgo, peerId: string): boolean {
    return resolveALCountedRecipientPeerIds(msg, algo)?.includes(peerId) === true;
}
