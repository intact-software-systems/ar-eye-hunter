import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    decodeALPeerControlMessage,
    newALAckControlMessage,
    newALNackControlMessage
} from '../../../al-contracts/al-control.ts';
import type {
    ALReceiptControl,
    ALReceiptProofFailure,
    ALReceiptProofSignerPort
} from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { toALMessageTrace } from '../../../al-contracts/trace/to-al-message-trace.ts';
import type { SignatureProof } from '../../../signature/signature-proof.ts';
import type { ALInboundCommitBundle } from '../al-inbound-admission-store.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundRuntimeDiagnosticsSink
} from '../al-inbound-runtime-diagnostics.ts';
import { toALInboundWorkEntryWithPayload, type ALInboundDurableEffectWrite } from '../al-inbound-work-entry.ts';
import type { ALInboundSignFailurePolicy } from './is-al-inbound-recipient-receipt.ts';

/** How a composition authenticates its counted recipients' controls: by the carrier alone, or by their own signature. */
export type ALInboundReceiptProofs =
    | Readonly<{ kind: 'carrier-authenticated'; }>
    | Readonly<{ kind: 'signed'; signer: ALReceiptProofSignerPort; }>;

export interface SignALInboundReceiptControlsInput extends SignALInboundReceiptEffectsInput {
    readonly bundle: ALInboundCommitBundle;
}

export interface SignALInboundReceiptEffectsInput {
    readonly namespace: string;
    readonly receiptProofs: ALInboundReceiptProofs;
    /** What becomes of a marked control whose signature failed: one message's rule, read by its caller. */
    readonly signFailure: ALInboundSignFailurePolicy;
    readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
}

interface ALInboundMarkedControl {
    readonly msg: ALMessage;
    readonly control: ALReceiptControl;
}

/**
 * Runs after validation and before the commit, so the stored control is the signed one every later send resends. A
 * control whose signature failed is left out and nothing goes unsigned in its place, a lost control the retry repairs,
 * unless `signFailure` sends it unsigned: an unreceipted message's gap NACK, which its origin admits unsigned only from
 * its own recipient (ruling 19).
 */
export async function signALInboundReceiptControls(
    input: SignALInboundReceiptControlsInput
): Promise<ALInboundCommitBundle> {
    const { bundle, receiptProofs } = input;
    if (receiptProofs.kind === 'carrier-authenticated') {
        return bundle;
    }
    return { ...bundle, durableEffects: await signALInboundReceiptEffects(bundle.durableEffects, input) };
}

/** Each marked effect signed, and one whose signature failed left out; every other effect as it was. */
export async function signALInboundReceiptEffects(
    effects: readonly ALInboundDurableEffectWrite[],
    input: SignALInboundReceiptEffectsInput
): Promise<readonly ALInboundDurableEffectWrite[]> {
    const { receiptProofs } = input;
    if (receiptProofs.kind === 'carrier-authenticated') {
        return effects;
    }
    const signed = await Promise.all(
        effects.map(async (effect) =>
            effect.signsForRecipient ? await signRecipientControl(input, receiptProofs.signer, effect) : effect
        )
    );
    return signed.filter((effect): effect is ALInboundDurableEffectWrite => effect !== undefined);
}

async function signRecipientControl(
    input: SignALInboundReceiptEffectsInput,
    signer: ALReceiptProofSignerPort,
    effect: ALInboundDurableEffectWrite
): Promise<ALInboundDurableEffectWrite | undefined> {
    const marked = toALInboundMarkedControl(effect);
    assertALInboundMarkedControl(marked);
    const proof = await signer.signReceiptProof(marked.control);
    return proof.fold(
        (failure) => {
            recordReceiptSignFailure(input.diagnostics, marked, failure);
            return input.signFailure === 'send-unsigned' ? effect : undefined;
        },
        (signature) =>
            toALInboundWorkEntryWithPayload(effect, input.namespace, {
                kind: 'send-control',
                msg: toSignedControlMessage(marked, signature)
            })
    );
}

/** The ACK or NACK a marked effect sends; `undefined` for any other effect. */
function toALInboundMarkedControl(effect: ALInboundDurableEffectWrite): ALInboundMarkedControl | undefined {
    if (effect.payload.kind !== 'send-control') {
        return undefined;
    }
    const control = decodeALPeerControlMessage(effect.payload.msg).right;
    return control === undefined || control.type === 'repair' ? undefined : { msg: effect.payload.msg, control };
}

/** Only an ACK or NACK a counted recipient authors about itself is ever marked. */
function assertALInboundMarkedControl(
    marked: ALInboundMarkedControl | undefined
): asserts marked is ALInboundMarkedControl {
    if (marked === undefined) {
        throw new TypeError('A marked inbound effect is not a receipt control');
    }
}

function toSignedControlMessage(marked: ALInboundMarkedControl, proof: SignatureProof): ALMessage {
    const { msg, control } = marked;
    return control.type === 'ack'
        ? newALAckControlMessage(msg.id, { ...control.payload, proof })
        : newALNackControlMessage(msg.id, { ...control.payload, proof });
}

function recordReceiptSignFailure(
    diagnostics: ALInboundRuntimeDiagnosticsSink | undefined,
    marked: ALInboundMarkedControl,
    failure: ALReceiptProofFailure
): void {
    const { msg, control } = marked;
    recordALInboundDiagnostic(diagnostics, {
        kind: 'receipt-sign',
        msgId: msg.id.msgId,
        typeId: msg.payload.typeId,
        targetMsgId: control.type === 'ack' ? control.payload.ackedMsgId : control.payload.msgId,
        reason: `${failure.kind}: ${failure.message}`,
        ...toALMessageTrace(msg)
    });
}
