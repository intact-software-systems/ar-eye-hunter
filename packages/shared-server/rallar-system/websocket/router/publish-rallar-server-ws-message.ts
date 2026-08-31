import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueResult, ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult,
    RallarServerWsPublishStatus
} from './rallar-server-ws-router-contracts.ts';

export interface PublishRallarServerWsMessageInput {
    readonly service: WsQueueBoxServerService;
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly wakeOutbox?: () => void;
    readonly authorizedRoomSnapshot?: GroupSnapshot;
}

export async function publishRallarServerWsMessage(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    switch (input.fanout) {
        case 'none':
            return {
                fanout: input.fanout,
                status: 'none',
                message: input.message,
                sentCount: 0,
                entries: []
            };
        case 'outbox': {
            const result = await input.service.enqueueOutboxIfAbsent(input.message);
            if (result.status === 'enqueued' || result.status === 'duplicate') {
                input.wakeOutbox?.();
            }
            return toOutboxPublishResult(input.message, input.fanout, result);
        }
        case 'live-only': {
            const result = input.service.sendToTargetsWithResult(input.message, input.authorizedRoomSnapshot);
            if (result.status === 'no-recipients') {
                console.warn(`Rallar server WS topic had no recipients: ${input.message.route.topicId}`);
            }
            return toLivePublishResult(input.message, input.fanout, result);
        }
    }
}

function toLivePublishResult(
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

function toOutboxPublishResult(
    message: ALMessage,
    fanout: RallarServerWsFanout,
    result: ALOutboundEnqueueResult
): RallarServerWsPublishResult {
    return {
        fanout,
        status: toOutboxPublishStatus(result.status),
        message,
        entry: result.entry,
        entries: result.entries,
        enqueueStatus: result.status,
        reason: result.reason
    };
}

function toOutboxPublishStatus(
    status: ALOutboundEnqueueStatus
): RallarServerWsPublishStatus {
    switch (status) {
        case 'enqueued':
            return 'queued-outbox';
        case 'sent-immediate':
            return 'sent-live';
        case 'skipped':
        case 'duplicate':
        case 'superseded':
        case 'expired':
        case 'no-route':
        case 'rate-limited':
        case 'circuit-open':
        case 'failed':
            return status;
    }
}
