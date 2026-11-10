import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, newALNackControlMessage } from '../../../al-contracts/al-control.ts';
import type { ALReceiptControl } from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';

/** The hop a relay forwards a child's control over: its own name, its parent, and the carrier it sends on. */
export interface ALForwardedReceiptControlHop {
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly carrier: ALDeliveryCarrier;
}

/** The recipient's control in a new envelope: only fromPeerId, toPeerId and an ACK's carrier are the relay's. */
export function toALForwardedReceiptControlMessage(
    id: ALMessage['id'],
    control: ALReceiptControl,
    hop: ALForwardedReceiptControlHop
): ALMessage {
    const route = { fromPeerId: hop.fromPeerId, toPeerId: hop.toPeerId };
    return control.type === 'ack'
        ? newALAckControlMessage(id, { ...control.payload, ...route, carrier: hop.carrier })
        : newALNackControlMessage(id, { ...control.payload, ...route });
}
