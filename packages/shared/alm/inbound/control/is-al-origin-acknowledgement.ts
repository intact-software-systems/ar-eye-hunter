import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../../al-contracts/al-control.ts';

/** The origin of a message keeps no inbound decision surface for it, so its own acknowledgements are outbound's. */
export function isALOriginAcknowledgement(msg: ALMessage, selfPeerId: string): boolean {
    const control = decodeALControlMessage(msg).right;
    return control?.type === 'ack' && control.payload.originPeerId === selfPeerId;
}
