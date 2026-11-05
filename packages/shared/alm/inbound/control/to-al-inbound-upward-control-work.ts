import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '../../../al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    type ALPendingAckSnapshot
} from '../../../al-contracts/al-control.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import type { ALOutsideAudienceNackReason } from '../../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALInboundMessageOwner } from '../al-inbound-admission-store.ts';
import type { ALInboundUpwardAck } from '../al-inbound-effect-intent.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import {
    computeALInboundWorkEntry,
    toALInboundEffectId,
    type ALInboundDurableEffectWrite
} from '../al-inbound-work-entry.ts';

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

/** One control a relay sends toward the origin: an ACK it relays or ends its hop with, or a NACK it relays. */
export type ALInboundUpwardControl =
    | Readonly<{ kind: 'ack'; ack: ALInboundUpwardAck; }>
    | Readonly<{ kind: 'nack'; logicalRecipientPeerId: string; reason: ALOutsideAudienceNackReason; }>;

/** The relay re-originates each control to its row's parent, over the carrier the message arrived on (D40). */
export function toALInboundUpwardControlWork(
    context: ALInboundUpwardControlContext,
    controls: readonly ALInboundUpwardControl[],
    retention: NormalizedALRuntimeStoreRetentionConfig
): readonly ALInboundDurableEffectWrite[] {
    const carrier = toALDeliveryCarrier(context.owner.source);
    return controls.map((control, index) => {
        const controlMsgId = `${context.controlMsgId}:${index}`;
        const msg = toUpwardControlMessage(context, control, controlMsgId);
        return computeALInboundWorkEntry({
            namespace: context.namespace,
            observedAtMs: context.nowMs,
            effectId: toALInboundEffectId([
                control.kind,
                context.msgId,
                context.pending.toPeerId,
                control.kind === 'ack' ? control.ack.status : control.logicalRecipientPeerId,
                controlMsgId
            ]),
            expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                context.pending.expireAtTimestamp,
                retention.durableEffectTtlMs,
                context.nowMs
            ),
            carrier,
            payload: { kind: 'send-control', msg }
        });
    });
}

function toUpwardControlMessage(
    context: ALInboundUpwardControlContext,
    control: ALInboundUpwardControl,
    controlMsgId: string
): ALMessage {
    const { relayPeerId, nowMs } = context;
    const id = {
        v: AL_MESSAGE_ENVELOPE_VERSION,
        msgId: controlMsgId,
        senderId: relayPeerId,
        ts: nowMs,
        traceId: context.traceId
    };
    const route = { fromPeerId: relayPeerId, toPeerId: context.pending.toPeerId, observedAtEpochMs: nowMs };
    if (control.kind === 'nack') {
        return newALNackControlMessage(id, {
            ...route,
            msgId: context.msgId,
            logicalRecipientPeerId: control.logicalRecipientPeerId,
            reason: control.reason
        });
    }
    return newALAckControlMessage(id, {
        ...route,
        ackedMsgId: context.msgId,
        originPeerId: context.owner.senderId,
        logicalRecipientPeerId: control.ack.logicalRecipient.kind === 'self'
            ? relayPeerId
            : control.ack.logicalRecipient.peerId,
        carrier: toALDeliveryCarrier(context.owner.source),
        status: control.ack.status
    });
}
