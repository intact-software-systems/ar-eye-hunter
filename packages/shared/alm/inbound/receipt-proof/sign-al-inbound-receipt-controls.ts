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

/** How a composition authenticates its counted recipients' controls: by the carrier alone, or by their own signature. */
export type ALInboundReceiptProofs =
    | Readonly<{ kind: 'carrier-authenticated'; }>
    | Readonly<{ kind: 'signed'; signer: ALReceiptProofSignerPort; }>;

export interface SignALInboundReceiptControlsInput {
    readonly bundle: ALInboundCommitBundle;
    readonly namespace: string;
    readonly receiptProofs: ALInboundReceiptProofs;
    readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
}

interface ALInboundMarkedControl {
    readonly msg: ALMessage;
    readonly control: ALReceiptControl;
}

/**
 * Runs after validation and before the commit, so the stored control is the signed one every later send resends. A
 * control whose signature failed is left out and nothing goes unsigned in its place: it is a lost control the retry
 * repairs.
 */
export async function signALInboundReceiptControls(
    input: SignALInboundReceiptControlsInput
): Promise<ALInboundCommitBundle> {
    const { bundle, receiptProofs } = input;
    if (receiptProofs.kind === 'carrier-authenticated') {
        return bundle;
    }
    const signed = await Promise.all(
        bundle.durableEffects.map(async (effect) =>
            effect.signsForRecipient ? await signRecipientControl(input, receiptProofs.signer, effect) : effect
        )
    );
    return {
        ...bundle,
        durableEffects: signed.filter((effect): effect is ALInboundDurableEffectWrite => effect !== undefined)
    };
}

async function signRecipientControl(
    input: SignALInboundReceiptControlsInput,
    signer: ALReceiptProofSignerPort,
    effect: ALInboundDurableEffectWrite
): Promise<ALInboundDurableEffectWrite | undefined> {
    const marked = toALInboundMarkedControl(effect);
    assertALInboundMarkedControl(marked);
    const proof = await signer.signReceiptProof(marked.control);
    return proof.fold(
        (failure) => {
            recordReceiptSignFailure(input.diagnostics, marked, failure);
            return undefined;
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
