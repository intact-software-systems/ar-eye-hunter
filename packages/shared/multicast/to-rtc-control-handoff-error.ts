import type { ALOutboundEnqueueResult } from '../alm/outbound/al-outbound-message-runtime.ts';
import { NonRetryableException } from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';

/** A retryable control admission is an `Error` the inbound claim retries; a final refusal is a `NonRetryableException`. */
export function toRtcControlHandoffError(result: ALOutboundEnqueueResult): Error | undefined {
    switch (result.verdict.kind) {
        case 'pending':
        case 'admitted':
        case 'duplicate':
            return;
        case 'deferred':
        case 'unroutable':
        case 'storage-unavailable':
        case 'failed':
            return new Error(result.reason ?? `RTC control admission returned ${result.verdict.kind}`);
        case 'refused':
        case 'skipped':
        case 'superseded':
        case 'expired':
            return new NonRetryableException(result.reason ?? `RTC control admission returned ${result.verdict.kind}`);
    }
}
