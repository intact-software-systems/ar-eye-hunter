import type { ALOutboundEnqueueResult } from '../alm/outbound/al-outbound-message-runtime.ts';

/**
 * Whether an RTC enqueue counts as a success for its circuit breaker. A typed refusal is a policy value
 * (an unauthorized origin, an ack the carrier cannot track), not a transport failure, so it never opens
 * the breaker; a failure, another refusal, and the protection results themselves do.
 */
export function isRtcEnqueueBreakerSuccess(result: ALOutboundEnqueueResult): boolean {
    const verdict = result.verdict;
    switch (verdict.kind) {
        case 'failed':
            return false;
        case 'refused':
            return verdict.reason === 'unauthorized' || verdict.reason === 'unsupported';
        case 'unroutable':
            return verdict.reason !== 'rate-limited' && verdict.reason !== 'circuit-open';
        default:
            return true;
    }
}
