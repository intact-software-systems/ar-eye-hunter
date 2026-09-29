import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '../../al-contracts/al-message-resource-limits.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import type { ALVolatileSessionBudget } from './al-volatile-session-budget.ts';

/**
 * The budget's view of one planned or arrived data message, or `undefined` when its sender named no deadline.
 * Such an envelope's expiry is `ttl-only` with no `expiresAtMs` of its own: its
 * `constraints.expiresAtMs` is only the lifetime every planner stamps (`toALOutboundMessage`). RTC signaling
 * (`WsRtcSignalingTransportUsingWsQBox.send`) travels that way, and the bound must neither count nor refuse it.
 */
export function toALVolatileSessionAdmission(
    msg: ALMessage,
    nowMs: number
): ALVolatileSessionBudget.Admission | undefined {
    const deadlineAtMs = resolveALNamedDeadlineAtMs(msg);
    if (deadlineAtMs === undefined) {
        return undefined;
    }
    return {
        msgId: msg.id.msgId,
        bytes: computeALMessageEnvelopeBytes(msg).right ?? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
        deadlineAtMs,
        nowMs
    };
}

function resolveALNamedDeadlineAtMs(msg: ALMessage): number | undefined {
    const expiry = msg.qos?.expiry;
    return expiry?.algo === 'ttl-only' && expiry.opts?.expiresAtMs === undefined
        ? undefined
        : resolveALMessageExpireAtMs(msg);
}
