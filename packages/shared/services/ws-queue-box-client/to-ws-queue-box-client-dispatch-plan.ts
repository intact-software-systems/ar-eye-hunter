import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALQosEffectivePolicy,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import { computeALOutboundAckRefusal } from '../../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundRetryTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import {
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';
import { toWsQueueBoxClientAckTrackingPlan } from './ws-queue-box-client-receipt-tracking.ts';

export interface WsQueueBoxClientDispatchContext {
    readonly sessionId: string;
    /** The peer id the WS server answers as; undefined when the server names none. */
    readonly serverPeerId: string | undefined;
    readonly socketOpen: boolean;
    readonly qosProvider: ALQosInputProvider;
}

/** How the WS client sends one message: its normalized policy, the receipt it tracks, and its retry and supersedence. */
export function toWsQueueBoxClientDispatchPlan(
    msg: ALMessage,
    context: WsQueueBoxClientDispatchContext
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const normalizationInput = resolveALQosNormalizationInput(
        msg,
        {
            direction: 'outbound',
            selfPeerId: context.sessionId,
            connectedPeerIds: context.socketOpen ? [context.sessionId] : []
        },
        context.qosProvider
    );
    const normalized = normalizeALQosPolicy(msg, normalizationInput);
    const message = toALOutboundMessage(msg, normalized.effective);
    const refusal = computeALOutboundAckRefusal<ALOutboundTransportMessage>({
        msg: message,
        carrier: 'ws',
        policy: normalized
    });
    return refusal.fold<ALOutboundDispatchPlan<ALOutboundTransportMessage>>(
        (refused) => refused,
        () => ({
            msg: message,
            dropReasonCode: undefined,
            persist: shouldPersistOutbox(normalized.effective),
            preparedMessages: [toALOutboundTransportMessage(message)],
            ackTracking: toWsQueueBoxClientAckTrackingPlan(
                normalized.effective,
                msg,
                context.serverPeerId
            ),
            retryTracking: toRetryTrackingPlan(normalized.effective),
            repairTracking: {
                enabled: normalized.effective.repair.algo !== 'none',
                algo: normalized.effective.repair.algo,
                maxAttempts: normalized.effective.repair.opts.maxRepairs
            },
            supersedenceTracking: toSupersedenceTrackingPlan(normalized.effective, msg)
        })
    );
}

function toRetryTrackingPlan(
    effective: ALQosEffectivePolicy
): ALOutboundRetryTrackingPlan | undefined {
    if (effective.retry.algo === 'none') {
        return undefined;
    }

    return {
        enabled: true,
        maxAttempts: effective.retry.opts.maxAttempts
    };
}

function toSupersedenceTrackingPlan(
    effective: ALQosEffectivePolicy,
    msg: ALMessage
): ALOutboundSupersedenceTrackingPlan | undefined {
    if (effective.supersedence.algo === 'none') {
        return undefined;
    }

    return {
        enabled: true,
        algo: effective.supersedence.algo,
        key: resolveSupersedenceKey(msg, effective),
        replacesMsgId: effective.supersedence.opts.replacesMsgId
    };
}
