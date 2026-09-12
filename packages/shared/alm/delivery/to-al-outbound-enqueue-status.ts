import type { ALOutboundEnqueueStatus } from '../outbound/al-outbound-message-runtime.ts';
import type { ALDeliveryAdmissionVerdict } from './al-delivery-lifecycle.ts';

/**
 * The only place `ALOutboundEnqueueStatus` is derived from a verdict. Temporary by design: the S1
 * plan's Task 11 deletes this module together with `ALOutboundEnqueueStatus` once every consumer
 * reads `ALOutboundEnqueueResult.verdict` directly.
 */
export function toALOutboundEnqueueStatus(verdict: ALDeliveryAdmissionVerdict): ALOutboundEnqueueStatus {
    switch (verdict.kind) {
        case 'admitted':
            return verdict.durable ? 'enqueued' : 'accepted';
        case 'duplicate':
            return 'duplicate';
        case 'pending':
            return 'pending-admission';
        case 'deferred':
            return 'skipped';
        case 'refused':
            return verdict.reason === 'unauthorized' ? 'skipped' : 'failed';
        case 'unroutable':
            return verdict.reason;
        case 'superseded':
            return 'superseded';
        case 'expired':
            return 'expired';
        case 'skipped':
            return 'skipped';
        case 'failed':
            return 'failed';
    }
}
