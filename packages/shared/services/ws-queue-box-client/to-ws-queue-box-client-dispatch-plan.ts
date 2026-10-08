import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALOutboundStoreDurability,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    type ALQosEffectivePolicy,
    type ALQosInputProvider,
    type ALQosNormalizationInput
} from '../../al-contracts/al-policy.ts';
import { computeALOutboundAckRefusal } from '../../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
import { computeALOutboundOrderingRefusal } from '../../alm/outbound/admission/compute-al-outbound-ordering-refusal.ts';
import {
    toALOutboundCongestionDrop,
    type ALOutboundDispatchPlan,
    type ALOutboundRetryTrackingPlan,
    type ALOutboundSupersedenceTrackingPlan
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import {
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';
import { Either } from '../../resilience/Either.ts';
import { toWsQueueBoxClientAckTrackingPlan } from './ws-queue-box-client-receipt-tracking.ts';

export interface WsQueueBoxClientDispatchContext {
    readonly sessionId: string;
    /** The peer id the WS server answers as; undefined when the server names none. */
    readonly serverPeerId: string | undefined;
    readonly socketOpen: boolean;
    readonly nowMs: number;
    /**
     * The socket cannot take this session's own send now (D184). The client reads no `overloaded`: its session
     * ledger refuses those sends itself and names the limit it passed (D179).
     */
    readonly backpressured: boolean;
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
    }).flatMap<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>(
        (refused) => Either.ofLeft(refused),
        (admissible) => computeALOutboundOrderingRefusal({ msg: admissible, policy: normalized })
    ).flatMap<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>(
        (refused) => Either.ofLeft(refused),
        (orderable) => computeCongestionRefusal(orderable, normalizationInput, context)
    );
    return refusal.fold<ALOutboundDispatchPlan<ALOutboundTransportMessage>>(
        (refused) => refused,
        () => ({
            msg: message,
            dropReasonCode: undefined,
            lane: resolveALOutboundStoreDurability(normalized.effective.durability.algo),
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

/** The planner's congestion drop on the socket's backpressure alone: the session ledger owns `overloaded` (D185). */
function computeCongestionRefusal(
    msg: ALMessage,
    normalizationInput: ALQosNormalizationInput,
    context: WsQueueBoxClientDispatchContext
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    if (!context.backpressured) {
        return Either.ofRight(msg);
    }
    const handling = planALMessageHandling(
        msg,
        { nowMs: context.nowMs, selfPeerId: context.sessionId, overloaded: false, backpressured: true },
        normalizationInput
    );
    const congestionDrop = toALOutboundCongestionDrop(handling);
    return congestionDrop === undefined ? Either.ofRight(msg) : Either.ofLeft({
        msg,
        dropReason: handling.dropReason,
        dropReasonCode: 'congested',
        congestionDrop,
        lane: 'volatile',
        preparedMessages: []
    });
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
