import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundEnqueueStatus
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult,
    RallarServerWsPublishStatus,
    RallarServerWsRoomAudience
} from './rallar-server-ws-router-contracts.ts';

export interface PublishRallarServerWsMessageInput {
    readonly service: WsQueueBoxServerService;
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly wakeOutbox?: () => void;
    readonly audience?: RallarServerWsRoomAudience;
    readonly admittedPeerIds?: readonly string[];
    readonly nowEpochMs: number;
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
            const result = input.service.sendToTargetsWithResult(
                input.message,
                input.audience === undefined
                    ? undefined
                    : resolveAuthorizedRoomSessionIds(input.message, input.audience, input.nowEpochMs),
                input.admittedPeerIds
            );
            if (result.status === 'no-recipients') {
                console.warn(`Rallar server WS topic had no recipients: ${input.message.route.topicId}`);
            }
            return toLivePublishResult(input.message, input.fanout, result);
        }
    }
}

function resolveAuthorizedRoomSessionIds(
    message: ALMessage,
    audience: RallarServerWsRoomAudience,
    nowEpochMs: number
): readonly string[] {
    // A handler may change targets after authorization. Never reuse that authority
    // for a different scope or exclusions, or fall back to a cached audience.
    if (
        JSON.stringify(message.targets) !== JSON.stringify(audience.targets) ||
        (message.constraints?.expiresAtMs !== undefined && nowEpochMs > message.constraints.expiresAtMs)
    ) {
        return [];
    }
    const liveSessionIds = audience.sessions
        .filter((session) => isGroupSnapshotSessionLive(session, nowEpochMs))
        .map((session) => session.sessionId);
    const targets = audience.targets;
    switch (targets.mode) {
        case 'unicast':
            return liveSessionIds.includes(targets.toPeerId) ? [targets.toPeerId] : [];
        case 'multicast':
            return liveSessionIds;
        case 'broadcast':
            return liveSessionIds.filter((sessionId) =>
                !targets.exceptPeerIds?.includes(sessionId) &&
                (!targets.recipientPeerIds || targets.recipientPeerIds.includes(sessionId))
            );
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
        case 'accepted':
            return 'queued-outbox';
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
