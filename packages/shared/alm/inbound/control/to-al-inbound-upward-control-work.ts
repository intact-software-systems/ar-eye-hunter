import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    type ALAckStatus,
    type ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import type { ALReceiptControl } from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALInboundMessageOwner } from '../al-inbound-admission-store.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import {
    computeALInboundWorkEntry,
    toALInboundEffectId,
    type ALInboundDurableEffectWrite
} from '../al-inbound-work-entry.ts';
import { isALInboundRelayRecipientReceipt } from '../receipt-proof/is-al-inbound-recipient-receipt.ts';
import { toALForwardedReceiptControlMessage } from './to-al-forwarded-receipt-control-message.ts';

/** The relay a child's control reached, and the message it is about: whom its upward controls name. */
export interface ALInboundUpwardControlContext {
    readonly namespace: string;
    readonly msgId: string;
    /** The message-owner row: the origin is its sender, never what a child control claimed. */
    readonly owner: ALInboundMessageOwner;
    /** This relay: the peer the child's control was addressed to. */
    readonly relayPeerId: string;
    readonly pending: ALPendingAckSnapshot;
    readonly nowMs: number;
    readonly controlMsgId: string;
    /** The trace of the control being relayed, which names the controlled message's trace. */
    readonly traceId: string;
}

/** One control a relay sends toward the origin: its own ACK, or a child's control it forwards readdressed. */
export type ALInboundUpwardControl =
    | Readonly<{ kind: 'own-ack'; status: ALAckStatus; }>
    | Readonly<{ kind: 'forwarded'; control: ALReceiptControl; }>;

/** The relay sends each control to its row's parent, over the carrier the message arrived on (D40). */
export function toALInboundUpwardControlWork(
    context: ALInboundUpwardControlContext,
    controls: readonly ALInboundUpwardControl[],
    retention: NormalizedALRuntimeStoreRetentionConfig
): readonly ALInboundDurableEffectWrite[] {
    const carrier = toALDeliveryCarrier(context.owner.source);
    return controls.map((control, index) => {
        const controlMsgId = `${context.controlMsgId}:${index}`;
        return computeALInboundWorkEntry({
            namespace: context.namespace,
            observedAtMs: context.nowMs,
            effectId: toALInboundEffectId([
                control.kind,
                context.msgId,
                context.pending.toPeerId,
                control.kind === 'own-ack' ? control.status : control.control.payload.logicalRecipientPeerId,
                controlMsgId
            ]),
            expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                context.pending.expireAtTimestamp,
                retention.durableEffectTtlMs,
                context.nowMs
            ),
            carrier,
            payload: { kind: 'send-control', msg: toUpwardControlMessage(context, control, controlMsgId) },
            signsForRecipient: isALInboundRelayRecipientReceipt({
                controlKind: control.kind,
                carrier,
                relayPeerId: context.relayPeerId,
                upwardAudiencePeerIds: context.pending.upwardAudiencePeerIds
            })
        });
    });
}

function toUpwardControlMessage(
    context: ALInboundUpwardControlContext,
    control: ALInboundUpwardControl,
    controlMsgId: string
): ALMessage {
    const { relayPeerId, nowMs } = context;
    const carrier = toALDeliveryCarrier(context.owner.source);
    const id = {
        v: AL_MESSAGE_ENVELOPE_VERSION,
        msgId: controlMsgId,
        senderId: relayPeerId,
        ts: nowMs,
        traceId: context.traceId
    };
    if (control.kind === 'forwarded') {
        return toALForwardedReceiptControlMessage(id, control.control, {
            fromPeerId: relayPeerId,
            toPeerId: context.pending.toPeerId,
            carrier
        });
    }
    return newALAckControlMessage(id, {
        fromPeerId: relayPeerId,
        toPeerId: context.pending.toPeerId,
        observedAtEpochMs: nowMs,
        ackedMsgId: context.msgId,
        originPeerId: context.owner.senderId,
        logicalRecipientPeerId: relayPeerId,
        carrier,
        status: control.status,
        proof: null
    });
}
