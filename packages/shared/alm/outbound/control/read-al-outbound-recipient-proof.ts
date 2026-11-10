import type { ALPeerControlMessage } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type {
    ALReceiptProofRefusal,
    ALReceiptProofVerifierPort
} from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isALLogicalReceiptMode } from '../../../al-contracts/validate-al-ack-support.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';

/**
 * How an outbound owner knows who spoke a recipient's control: the carrier authenticates its peer (a WS client's
 * server, the WS server's sockets), or each counted recipient signs its own (the RTC overlay).
 */
export type ALOutboundRecipientAuthentication =
    | Readonly<{ kind: 'carrier'; }>
    | Readonly<{ kind: 'signature'; verifier: ALReceiptProofVerifierPort; }>;

export interface ReadALOutboundRecipientProofInput {
    readonly parsed: ALPeerControlMessage;
    readonly sent: ALStoredOutboundMessage | undefined;
    readonly recipientAuthentication: ALOutboundRecipientAuthentication;
}

/**
 * The verdict on who spoke the control. Under `signature` a peer ACK or NACK about a logically receipted send is
 * verified against the key the sent row froze for the recipient it names; an absent key record keys nobody.
 */
export async function readALOutboundRecipientProof(
    input: ReadALOutboundRecipientProofInput
): Promise<ALControlAdmissionRead['recipientProof']> {
    const { parsed, sent, recipientAuthentication } = input;
    const mode = sent?.policy.ackTracking?.mode;
    if (
        recipientAuthentication.kind === 'carrier' || parsed.type === 'repair' || sent === undefined ||
        mode === undefined || !isALLogicalReceiptMode(mode)
    ) {
        return 'carrier-authenticated';
    }
    const frozenKey = sent.policy.receiptProofKeys?.[parsed.payload.logicalRecipientPeerId];
    const verdict = await recipientAuthentication.verifier.verifyReceiptProof(parsed, frozenKey);
    return verdict.fold<ALControlAdmissionRead['recipientProof']>((refusal) => refusal, () => 'verified');
}

/** The refusal the verdict is, or undefined when the control's speaker is authenticated. */
export function toALOutboundProofRefusal(
    recipientProof: ALControlAdmissionRead['recipientProof']
): ALReceiptProofRefusal | undefined {
    return typeof recipientProof === 'object' ? recipientProof : undefined;
}

/** A refused proof is one `unauthorized` issue; an authenticated speaker adds none. */
export function validateALOutboundRecipientProof(
    recipientProof: ALControlAdmissionRead['recipientProof']
): readonly ALMessageRejection[] {
    const refusal = toALOutboundProofRefusal(recipientProof);
    return refusal === undefined
        ? []
        : [{ code: 'unauthorized', message: `AL control proof is refused: ${refusal.kind}` }];
}
