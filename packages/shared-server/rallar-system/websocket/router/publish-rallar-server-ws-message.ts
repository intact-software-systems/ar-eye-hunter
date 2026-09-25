import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    hasALDeliveryDurableWork,
    type ALDeliveryAdmissionVerdict
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
            if (hasALDeliveryDurableWork(result.verdict)) {
                input.wakeOutbox?.();
            }
            return toOutboxPublishResult(input.message, input.fanout, result);
        }
        case 'live-only': {
            const result = input.service.sendToTargetsWithResult(
                input.message,
                input.audience === undefined ? undefined : resolveAuthorizedRoomSessionIds({
                    message: input.message,
                    audience: input.audience,
                    admittedPeerIds: input.admittedPeerIds,
                    nowEpochMs: input.nowEpochMs
                }),
                input.admittedPeerIds
            );
            if (result.status === 'no-recipients') {
                console.warn(`Rallar server WS topic had no recipients: ${input.message.route.topicId}`);
            }
            return toLivePublishResult(input.message, input.fanout, result);
        }
    }
}

interface ResolveAuthorizedRoomSessionIdsInput {
    readonly message: ALMessage;
    readonly audience: RallarServerWsRoomAudience;
    /** The audience the message was admitted to; absent for a publish that was never admitted. */
    readonly admittedPeerIds: readonly string[] | undefined;
    readonly nowEpochMs: number;
}

/**
 * An admitted message goes to the audience it was admitted to, not to the room as it is now: a session that
 * left after admission stays addressed and its receipt reports it missing (D43). Socket liveness stays the
 * send-time decision, so a disconnected session is not sent to and simply never confirms.
 */
function resolveAuthorizedRoomSessionIds(input: ResolveAuthorizedRoomSessionIdsInput): readonly string[] {
    const { message, audience, nowEpochMs } = input;
    // A handler may change targets after authorization. Never reuse that authority
    // for a different scope or exclusions, or fall back to a cached audience.
    if (
        JSON.stringify(message.targets) !== JSON.stringify(audience.targets) ||
        (message.constraints?.expiresAtMs !== undefined && nowEpochMs > message.constraints.expiresAtMs)
    ) {
        return [];
    }
    const addressedSessionIds = input.admittedPeerIds ?? audience.sessions
        .filter((session) => isGroupSnapshotSessionLive(session, nowEpochMs))
        .map((session) => session.sessionId);
    const targets = audience.targets;
    switch (targets.mode) {
        case 'unicast':
            return addressedSessionIds.includes(targets.toPeerId) ? [targets.toPeerId] : [];
        case 'multicast':
            return addressedSessionIds.filter((sessionId) => sessionId !== message.id.senderId);
        case 'broadcast':
            return addressedSessionIds.filter((sessionId) =>
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
        status: toOutboxPublishStatus(result.verdict),
        message,
        entry: result.entry,
        entries: result.entries,
        verdict: result.verdict,
        reason: result.reason
    };
}

function toOutboxPublishStatus(
    verdict: ALDeliveryAdmissionVerdict
): RallarServerWsPublishStatus {
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
    }
}
