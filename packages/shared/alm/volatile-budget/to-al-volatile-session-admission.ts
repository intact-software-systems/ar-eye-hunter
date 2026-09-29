import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '../../al-contracts/al-message-resource-limits.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import type { ALVolatileSessionBudget } from './al-volatile-session-budget.ts';

/**
 * The budget's view of one data message, or `undefined` for a message with no deadline: the budget releases an
 * admission at its deadline, and RTC signaling (`WsRtcSignalingTransportUsingWsQBox.send`) is the volatile data a
 * session sends and receives without one, which the bound must never refuse.
 */
export function toALVolatileSessionAdmission(
    msg: ALMessage,
    nowMs: number
): ALVolatileSessionBudget.Admission | undefined {
    const deadlineAtMs = resolveALMessageExpireAtMs(msg);
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
