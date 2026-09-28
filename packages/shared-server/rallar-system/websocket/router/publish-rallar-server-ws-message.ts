import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { shouldAwaitALRoute } from '@shared/al-contracts/al-policy.ts';
import {
    hasALDeliveryDurableWork,
    type ALDeliveryAdmissionVerdict
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { validateALOutboundRecipientScope } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { WsServerLiveSendResult } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { LiveWsInboundReference } from '../../queue-pubsub/live-ws-notice.ts';
import { publishRallarServerLiveWsNotice } from './publish-rallar-server-live-ws-notice.ts';
import {
    isAuthorizedRoomAudience,
    readRallarServerWsPublicationAudience,
    resolveAuthorizedRoomSessionIds
} from './rallar-server-ws-publication-audience.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult,
    RallarServerWsPublishStatus,
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions
} from './rallar-server-ws-router-contracts.ts';

export interface PublishRallarServerWsMessageInput {
    readonly service: WsQueueBoxServerService;
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly wakeOutbox?: () => void;
    readonly audience?: RallarServerWsRoomAudience;
    readonly admittedPeerIds?: readonly string[];
    /** An explicit public scope or authenticated inbound scope; absent proof refuses unicast. */
    readonly inboundScope?: StateScope | null;
    readonly nowEpochMs: number;
    readonly livePublication?: RallarServerWsRouterOptions['livePublication'];
    readonly inbound?: LiveWsInboundReference;
    readonly origin?: 'server' | 'proxy' | 'admitted';
    readonly authorizeRoomMessage?: RallarServerWsRouterOptions['authorizeRoomMessage'];
}

export async function publishRallarServerWsMessage(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    let audience = input.audience;
    if (audience === undefined) {
        try {
            audience = await readRallarServerWsPublicationAudience({
                message: input.message,
                fanout: input.fanout,
                origin: input.origin,
                authorizeRoomMessage: input.authorizeRoomMessage,
                readServerRoomAudience: input.livePublication?.readServerRoomAudience
            });
        }
        catch (error) {
            // A public publish reports a failed operation; admitted/proxy dispatch keeps its retry signal.
            if (input.origin !== undefined) {
                throw error;
            }
            return toFailedPublishResult(input, error instanceof Error ? error.message : String(error));
        }
    }
    return await publishAuthorizedRallarServerWsMessage({ ...input, audience });
}

async function publishAuthorizedRallarServerWsMessage(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    if (input.message.targets?.mode === 'unicast' && validateALOutboundRecipientScope(input.inboundScope).length > 0) {
        return { fanout: input.fanout, status: 'skipped', message: input.message, sentCount: 0, entries: [] };
    }
    if (input.fanout === 'none') {
        return { fanout: 'none', status: 'none', message: input.message, sentCount: 0, entries: [] };
    }
    const targets = input.message.targets;
    const roomTarget = targets?.mode === 'multicast' ||
        (targets?.mode === 'broadcast' && targets.scope === 'room');
    if (input.livePublication && roomTarget) {
        if (!readALTargetGroupRef(input.message)) {
            return toFailedPublishResult(input, 'Room publication requires a full group reference.');
        }
        if (!input.audience) {
            return toFailedPublishResult(input, 'Room publication has no authorized frozen audience.');
        }
    }
    if (input.audience && !isAuthorizedRoomAudience(input.message, input.audience, input.nowEpochMs)) {
        return toFailedPublishResult(input, 'Room publication audience does not authorize the final message targets.');
    }
    const normalized = input.service.resolveOutboundPolicy(input.message);
    if (normalized.unmetRequirements.length > 0) {
        return toFailedPublishResult(input, normalized.unmetRequirements.join('; '));
    }
    const requiresDurableWork = shouldAwaitALRoute(normalized.effective);
    if (normalized.effective.delivery.algo !== 'best-effort' && !requiresDurableWork) {
        return toFailedPublishResult(input, 'Effective delivery requires durable outbound work.');
    }
    if (requiresDurableWork && input.fanout !== 'outbox') {
        return toFailedPublishResult(input, 'Explicit live-only fanout is incompatible with durable outbound work.');
    }
    if (!requiresDurableWork && input.livePublication) {
        return await publishRallarServerLiveWsNotice(input, normalized.effective);
    }
    switch (input.fanout) {
        case 'outbox': {
            const result = await input.service.enqueueOutboxIfAbsent(
                input.message,
                toAdmittedAudience(input),
                input.message.targets?.mode === 'unicast' ? input.inboundScope ?? undefined : undefined
            );
            if (hasALDeliveryDurableWork(result.verdict)) {
                input.wakeOutbox?.();
            }
            return toOutboxPublishResult(input.message, input.fanout, result);
        }
        case 'live-only': {
            const result = input.service.sendToTargetsWithResult({
                message: input.message,
                recipientSessionIds: input.audience === undefined ? undefined : resolveAuthorizedRoomSessionIds({
                    message: input.message,
                    audience: input.audience,
                    admittedPeerIds: input.admittedPeerIds,
                    nowEpochMs: input.nowEpochMs
                }),
                admittedPeerIds: input.admittedPeerIds,
                inboundScope: input.inboundScope
            });
            if (result.status === 'no-recipients') {
                console.warn(`Rallar server WS topic had no recipients: ${input.message.route.topicId}`);
            }
            return toLivePublishResult(input.message, input.fanout, result);
        }
    }
}

function toFailedPublishResult(input: PublishRallarServerWsMessageInput, reason: string): RallarServerWsPublishResult {
    return { fanout: input.fanout, status: 'failed', message: input.message, entries: [], reason };
}

/**
 * The sessions the live branch would address, handed to the outbox beside the message: the server's own
 * outbound owner sends to that audience and its pending row expects it, never the sessions that happen to
 * be connected to the instance that dequeues it (D24, D43). The wire message stays as the origin sent it,
 * so a room larger than the collection limit still fans out.
 */
function toAdmittedAudience(input: PublishRallarServerWsMessageInput): readonly string[] | undefined {
    const { message, audience, admittedPeerIds } = input;
    return audience === undefined
        ? undefined
        : resolveAuthorizedRoomSessionIds({ message, audience, admittedPeerIds, nowEpochMs: input.nowEpochMs });
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
