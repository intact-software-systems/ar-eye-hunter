import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckStatus,
    ALNackReason,
    ALRepairReason
} from '../../al-contracts/al-control.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { ALOrderingObservation } from '../../al-contracts/al-runtime.ts';
import type { ALInboundDurableEffect, ALInboundMessageReadDto } from './al-inbound-admission-store.ts';

export interface ALInboundEffectIntent {
    readonly effectId: string;
    readonly expireAtTimestamp: number | undefined;
    readonly payload:
        | {
            readonly kind: 'dispatch-local' | 'enqueue-inbox';
            readonly msg: ALMessage;
            readonly plan: ALMessageHandlingPlan;
        }
        | {
            readonly kind: 'send-ack';
            readonly toPeerId: string;
            readonly ackedMsgId: string;
            readonly status: ALAckStatus;
        }
        | {
            readonly kind: 'send-nack';
            readonly toPeerId: string;
            readonly msgId: string;
            readonly reason: ALNackReason;
            readonly ordering: ALOrderingObservation | undefined;
        }
        | {
            readonly kind: 'send-repair';
            readonly toPeerId: string;
            readonly msgId: string;
            readonly reason: ALRepairReason;
            readonly ordering: ALOrderingObservation;
        }
        | Extract<ALInboundDurableEffect, { readonly kind: 'forward-message' | 'release-buffered'; }>;
}

interface ALInboundLocalDeliveryInput {
    readonly msg: ALMessage;
    readonly plan: ALMessageHandlingPlan;
}

export interface ALInboundControlEffectInput extends ALInboundLocalDeliveryInput {
    readonly fromPeerId: string;
}

interface ALInboundAckEffectInput {
    readonly toPeerId: string;
    readonly ackedMsgId: string;
    readonly status: ALAckStatus;
    readonly expireAtTimestamp: number | undefined;
}

export function toALInboundForwardingEffects(
    input: ALInboundControlEffectInput,
    shouldForward: boolean
): readonly ALInboundEffectIntent[] {
    if (shouldForward) {
        return [{
            effectId: toEffectId(['forward', input.msg.id.senderId, input.msg.id.msgId, input.fromPeerId]),
            expireAtTimestamp: resolveALMessageExpireAtMs(input.msg, input.plan.effective),
            payload: { kind: 'forward-message', msg: input.msg, fromPeerId: input.fromPeerId, plan: input.plan }
        }];
    }
    return !input.plan.localDelivery.deferred && !input.plan.nack.enabled ? toRepairEffects(input) : [];
}

export function toALInboundBufferedReleaseEffects(read: ALInboundMessageReadDto): readonly ALInboundEffectIntent[] {
    const trackKey = read.orderingAcceptance.observation.trackKey;
    if (read.plan.localDelivery.deferred || !trackKey) {
        return [];
    }
    return read.orderingAcceptance.observation.releasableSeqs.map((seq) => ({
        effectId: toEffectId(['release', trackKey, seq]),
        expireAtTimestamp: undefined,
        payload: { kind: 'release-buffered', trackKey, seq }
    }));
}

export function toALInboundLocalDeliveryEffects(
    input: ALInboundLocalDeliveryInput
): readonly ALInboundEffectIntent[] {
    if (!input.plan.localDelivery.enabled) {
        return [];
    }
    const queued = shouldDeferALInboundLocalDelivery(input.plan) || input.plan.localDelivery.persist;
    return [{
        effectId: toEffectId([queued ? 'inbox' : 'dispatch', input.msg.id.senderId, input.msg.id.msgId]),
        expireAtTimestamp: resolveALMessageExpireAtMs(input.msg, input.plan.effective),
        payload: {
            kind: queued ? 'enqueue-inbox' : 'dispatch-local',
            msg: input.msg,
            plan: input.plan
        }
    }];
}

export function toALInboundNegativeControlEffects(
    input: ALInboundControlEffectInput
): readonly ALInboundEffectIntent[] {
    if (!input.plan.nack.enabled) {
        return [];
    }
    const toPeerId = input.plan.nack.toPeerId ?? input.fromPeerId;
    const reason = toNackReason(input.plan.nack.reason);
    const nack: ALInboundEffectIntent = {
        effectId: toEffectId(['nack', input.msg.id.senderId, input.msg.id.msgId, toPeerId, reason]),
        expireAtTimestamp: resolveALMessageExpireAtMs(input.msg, input.plan.effective),
        payload: {
            kind: 'send-nack',
            toPeerId,
            msgId: input.msg.id.msgId,
            reason,
            ordering: reason === 'not-yet-in-sync' ? undefined : input.plan.orderingRuntime
        }
    };
    return reason === 'not-yet-in-sync' ? [nack] : [nack, ...toRepairEffects(input)];
}

function toRepairEffects(
    input: ALInboundControlEffectInput
): readonly ALInboundEffectIntent[] {
    if (!input.plan.repair.enabled && input.plan.orderingRuntime.status !== 'gap') {
        return [];
    }
    const toPeerId = input.plan.nack.toPeerId ?? input.fromPeerId;
    return [{
        effectId: toEffectId([
            'repair',
            input.msg.id.senderId,
            input.msg.id.msgId,
            toPeerId,
            input.plan.orderingRuntime.trackKey ?? '-',
            input.plan.orderingRuntime.seq ?? '-',
            input.plan.orderingRuntime.expectedSeq ?? '-',
            input.plan.orderingRuntime.missingSeqs.join(',')
        ]),
        expireAtTimestamp: resolveALMessageExpireAtMs(input.msg, input.plan.effective),
        payload: {
            kind: 'send-repair',
            toPeerId,
            msgId: input.msg.id.msgId,
            reason: input.plan.orderingRuntime.status === 'gap' ? 'missing-seq' : 'retransmit',
            ordering: input.plan.orderingRuntime
        }
    }];
}

export function toALInboundAckEffect(input: ALInboundAckEffectInput): ALInboundEffectIntent {
    return {
        effectId: toEffectId(['ack', input.ackedMsgId, input.toPeerId, input.status]),
        expireAtTimestamp: input.expireAtTimestamp,
        payload: {
            kind: 'send-ack',
            toPeerId: input.toPeerId,
            ackedMsgId: input.ackedMsgId,
            status: input.status
        }
    };
}

function toEffectId(
    parts: readonly (number | string)[]
): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}

function toNackReason(reason?: string) {
    switch (reason) {
        case 'gap':
            return 'gap' as const;
        case 'expired':
            return 'expired' as const;
        case 'overloaded':
            return 'overloaded' as const;
        case 'not-yet-in-sync':
            return 'not-yet-in-sync' as const;
        default:
            return 'stale' as const;
    }
}

export function shouldDeferALInboundLocalDelivery(
    plan: ALMessageHandlingPlan
): boolean {
    return plan.localDelivery.enabled &&
        plan.congestion.overloaded &&
        plan.congestion.action === 'defer';
}
