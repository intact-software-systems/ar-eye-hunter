import type { ALOutboundCapturedPolicy } from '../../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundDequeueAuthority } from '../../../alm/outbound/al-outbound-message-runtime.ts';

/**
 * The captured sessions the judged audience no longer holds, in captured order; undefined when the dequeue judged no
 * audience or either audience is undefined.
 */
export function toWsQueueBoxServerJudgedDrops(
    captured: ALOutboundCapturedPolicy | undefined,
    judged: ALOutboundDequeueAuthority | undefined
): readonly string[] | undefined {
    const capturedAudience = captured?.admittedAudience;
    const judgedAudience = judged?.audienceJudged === true ? judged.admittedAudience : undefined;
    if (capturedAudience === undefined || judgedAudience === undefined) {
        return undefined;
    }
    const kept = new Set(judgedAudience);
    return capturedAudience.filter((sessionId) => !kept.has(sessionId));
}
