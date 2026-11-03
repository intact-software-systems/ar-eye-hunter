import type { ALMessageDropReasonCode } from '../al-contracts/al-policy.ts';
import type { ALOutboundDropReasonCode } from '../alm/outbound/al-outbound-message-runtime.ts';

/** The six codes shared with inbound handling carry over; an inbound-only code has no outbound route concept. */
export function toALOutboundDropReasonCodeFromHandlingPlan(
    code: ALMessageDropReasonCode | undefined
): ALOutboundDropReasonCode {
    switch (code) {
        case 'duplicate':
        case 'superseded':
        case 'expired':
        case 'not-yet-in-sync':
        case 'unauthorized':
        case 'congested':
            return code;
        case 'overloaded':
            return 'capacity';
        case 'membership-fenced':
            return 'unauthorized';
        case 'unmet-requirements':
        case 'ordering-rejected':
        case 'resync-required':
        case 'held-by-other':
        case undefined:
            return 'planner-drop';
    }
}
