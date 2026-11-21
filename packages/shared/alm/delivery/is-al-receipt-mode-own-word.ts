import type { ALAckPayload, ALNackPayload } from '../../al-contracts/al-control.ts';
import type { ALAckAlgo } from '../../al-contracts/al-policy.ts';
import { isALOwnWord } from '../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';

/**
 * Whether a receipt of `mode` hears this control as its recipient's word: any control under a logical receipt, whose
 * counted recipients sign their own; under `hop` and `subtree` only the recipient's own control on its own channel.
 */
export function isALReceiptModeOwnWord(
    mode: ALAckAlgo,
    control: Pick<ALAckPayload | ALNackPayload, 'fromPeerId' | 'logicalRecipientPeerId'>
): boolean {
    return isALLogicalReceiptMode(mode) || isALOwnWord(control);
}
