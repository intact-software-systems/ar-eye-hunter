import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALPeerControlMessage } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import {
    isALOwnWord,
    toALReceiptProofRefusal,
    type ALReceiptControl,
    type ALReceiptProofRefusal,
    type ALReceiptProofVerifierPort
} from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isALLogicalReceiptMode } from '../../../al-contracts/validate-al-ack-support.ts';
import type { GroupPresencePublicationKey } from '../../../api/group-types.ts';
import { isALCountedRecipient } from '../../delivery/resolve-al-counted-recipient-peer-ids.ts';
import type { ALStoredOutboundMessage } from '../admission/al-outbound-admission-validation.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import type { ALOutboundControlAdmissionResult } from './al-outbound-control-admission.ts';
import { isALOutboundRelayedGapNack } from './is-al-outbound-relayed-gap-nack.ts';

// This file also holds the control-admission refusal vocabulary: an issue's class, its constructors and the result.

/** A refusal's class beside its message: a `duplicate` repeats what the receipt already holds. */
export interface ALOutboundControlIssue extends ALMessageRejection {
    readonly class: 'duplicate' | 'refusal';
}

export function toALOutboundRefusalIssue(
    message: string,
    code: ALMessageRejection['code'] = 'unauthorized'
): ALOutboundControlIssue {
    return { code, message, class: 'refusal' };
}

export function toALOutboundDuplicateIssue(message: string): ALOutboundControlIssue {
    return { code: 'unauthorized', message, class: 'duplicate' };
}

/**
 * How an outbound owner knows who spoke a recipient's control: the carrier authenticates its peer (a WS client's
 * server, the WS server's sockets), or each counted recipient signs its own (the RTC overlay). Under `signature`,
 * `readRecipientKey` reads the key the message's room registers for a session now: a send that tracks no receipt froze
 * none (ruling 19).
 */
export type ALOutboundRecipientAuthentication =
    | Readonly<{ kind: 'carrier'; }>
    | Readonly<{
        kind: 'signature';
        verifier: ALReceiptProofVerifierPort;
        readRecipientKey(msg: ALMessage, peerId: string): GroupPresencePublicationKey | undefined;
    }>;

export interface ReadALOutboundRecipientProofInput {
    readonly parsed: ALPeerControlMessage;
    readonly sent: ALStoredOutboundMessage | undefined;
    /** Who may ask for the repair of a send that tracks no receipt; `undefined` for any other send. */
    readonly unreceiptedRepairAudience: ALControlAdmissionRead['unreceiptedRepairAudience'];
    readonly recipientAuthentication: ALOutboundRecipientAuthentication;
    /** The sent row's canonical message, whose frozen targets name the counted recipients; read only when a proof is judged. */
    readSentMessage(): Promise<ALMessage | undefined>;
}

/**
 * The verdict on who spoke the control. Under `signature` a peer ACK or NACK about a logically receipted send that
 * speaks for a recipient the receipt counts is verified against the key the sent row froze for it; an absent key
 * record keys nobody. One that speaks for a peer the receipt does not count is a hop fact its channel authenticates
 * when it speaks for its own sender, and keyed for nobody when it speaks for another. A gap NACK a relay re-sends for
 * a send that tracks no receipt asks for a repair charged to its recipient, so it is verified against the key the room
 * registers for that recipient now; one the room no longer keys is keyed for nobody (ruling 19). A control addressed
 * to another owner than the sent row's is not judged: the admission refuses it for its address.
 */
export async function readALOutboundRecipientProof(
    input: ReadALOutboundRecipientProofInput
): Promise<ALControlAdmissionRead['recipientProof']> {
    const { parsed, sent, recipientAuthentication } = input;
    if (
        recipientAuthentication.kind === 'carrier' || parsed.type === 'repair' || sent === undefined ||
        parsed.payload.toPeerId !== sent.reference.senderId
    ) {
        return 'carrier-authenticated';
    }
    if (input.unreceiptedRepairAudience !== undefined) {
        return isALOutboundRelayedGapNack(parsed)
            ? await readALOutboundUnreceiptedRecipientProof(input, parsed, recipientAuthentication)
            : 'carrier-authenticated';
    }
    const mode = sent.policy.ackTracking?.mode;
    if (mode === undefined || !isALLogicalReceiptMode(mode)) {
        return 'carrier-authenticated';
    }
    const { logicalRecipientPeerId } = parsed.payload;
    const msg = await input.readSentMessage();
    if (msg !== undefined && !isALCountedRecipient(msg, mode, logicalRecipientPeerId)) {
        return isALOwnWord(parsed.payload)
            ? 'carrier-authenticated'
            : toALReceiptProofRefusal('unknown-key', parsed);
    }
    const frozenKey = sent.policy.receiptProofKeys?.[logicalRecipientPeerId];
    return await verifyALOutboundRecipientProof(recipientAuthentication.verifier, parsed, frozenKey);
}

async function readALOutboundUnreceiptedRecipientProof(
    input: ReadALOutboundRecipientProofInput,
    control: ALReceiptControl,
    authentication: Extract<ALOutboundRecipientAuthentication, Readonly<{ kind: 'signature'; }>>
): Promise<ALControlAdmissionRead['recipientProof']> {
    const msg = await input.readSentMessage();
    const key = msg === undefined
        ? undefined
        : authentication.readRecipientKey(msg, control.payload.logicalRecipientPeerId);
    return await verifyALOutboundRecipientProof(authentication.verifier, control, key);
}

async function verifyALOutboundRecipientProof(
    verifier: ALReceiptProofVerifierPort,
    control: ALReceiptControl,
    key: GroupPresencePublicationKey | undefined
): Promise<ALControlAdmissionRead['recipientProof']> {
    const verdict = await verifier.verifyReceiptProof(control, key);
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
): readonly ALOutboundControlIssue[] {
    const refusal = toALOutboundProofRefusal(recipientProof);
    return refusal === undefined
        ? []
        : [toALOutboundRefusalIssue(`AL control proof is refused: ${refusal.kind}`)];
}

export function toALOutboundRefusedControlAdmission(
    issues: readonly ALOutboundControlIssue[],
    recipientProof: ALControlAdmissionRead['recipientProof']
): ALOutboundControlAdmissionResult {
    const reason = issues.map((issue) => issue.message).join('; ');
    if (issues.every((issue) => issue.class === 'duplicate')) {
        return { kind: 'duplicate', reason };
    }
    const proofRefusal = toALOutboundProofRefusal(recipientProof);
    return proofRefusal === undefined ? { kind: 'rejected', reason } : { kind: 'rejected', reason, proofRefusal };
}
