import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult,
    RallarServerWsPublishStatus
} from './rallar-server-ws-router-contracts.ts';

export function toRallarServerWsLivePublishResult(
    message: ALMessage,
    fanout: RallarServerWsFanout,
    result: WsServerLiveSendResult
): RallarServerWsPublishResult {
    return {
        fanout,
        status: result.status,
        message,
        sentCount: result.sentCount,
        recipientCount: result.recipientCount,
        failedCount: result.failedCount,
        recipients: result.recipients,
        failures: result.failures,
        entries: []
    };
}

export function toRallarServerWsOutboxPublishResult(
    fanout: RallarServerWsFanout,
    result: ALOutboundEnqueueResult
): RallarServerWsPublishResult {
    return {
        fanout,
        status: toOutboxPublishStatus(result.verdict),
        message: result.message,
        entry: result.entry,
        entries: result.entries,
        verdict: result.verdict,
        reason: result.reason
    };
}

function toOutboxPublishStatus(verdict: ALDeliveryAdmissionVerdict): RallarServerWsPublishStatus {
    switch (verdict.kind) {
        case 'admitted':
        case 'pending':
            return 'queued-outbox';
        case 'duplicate':
            return 'duplicate';
        case 'refused':
            return verdict.reason === 'unauthorized' ? 'skipped' : 'failed';
        case 'unroutable':
            return verdict.reason;
        // An enqueue-time deferred writes no outbox row, so it reports the same status as skipped.
        case 'deferred':
            return 'skipped';
        case 'superseded':
        case 'expired':
        case 'skipped':
        case 'failed':
            return verdict.kind;
        // The PostgreSQL store never answers it; an unpersisted admission reads as a failed one.
        case 'storage-unavailable':
            return 'failed';
    }
}
