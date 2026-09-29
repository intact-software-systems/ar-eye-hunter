import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { shouldAwaitALRoute, type ALQosNormalizationResult } from '@shared/al-contracts/al-policy.ts';
import { validateALOutboundRecipientScope } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { recordRallarTiming, type RallarTimingSink } from '../../observability/timing.ts';
import type { LiveWsInboundReference } from '../../queue-pubsub/live-ws-notice.ts';
import { publishRallarServerLiveWsNotice } from './publish-rallar-server-live-ws-notice.ts';
import { publishRallarServerWsFanout } from './publish-rallar-server-ws-fanout.ts';
import {
    isAuthorizedRoomAudience,
    readRallarServerWsPublicationAudience
} from './rallar-server-ws-publication-audience.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishInputDto,
    RallarServerWsPublishResult,
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions
} from './rallar-server-ws-router-contracts.ts';

export interface PublishRallarServerWsMessageInput {
    readonly service: WsQueueBoxServerService;
    readonly timing?: RallarTimingSink;
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout | undefined;
    readonly wakeOutbox?: () => void;
    readonly audience?: RallarServerWsRoomAudience;
    readonly admittedPeerIds?: readonly string[];
    /** An explicit public scope or authenticated inbound scope; absent proof refuses unicast. */
    readonly inboundScope?: StateScope | null;
    readonly nowEpochMs: number;
    readonly livePublication?: RallarServerWsRouterOptions['livePublication'];
    readonly readServerPublishAudience?: RallarServerWsRouterOptions['readServerPublishAudience'];
    readonly inbound?: LiveWsInboundReference;
    readonly origin?: 'server' | 'proxy' | 'admitted';
    readonly authorizeRoomMessage?: RallarServerWsRouterOptions['authorizeRoomMessage'];
}

export interface ResolvedRallarServerWsPublication extends PublishRallarServerWsMessageInput {
    readonly fanout: RallarServerWsFanout;
}

/** A malformed call is a programmer error, before operational audience reads can fail. */
export function assertRallarServerWsPublishInput(input: RallarServerWsPublishInputDto): void {
    const message = input?.message;
    if (
        !input || typeof input !== 'object' || Array.isArray(input) ||
        !message || typeof message !== 'object' || Array.isArray(message) ||
        !message.id || typeof message.id !== 'object' ||
        !message.route || typeof message.route !== 'object' ||
        !message.payload || typeof message.payload !== 'object'
    ) {
        throw new TypeError('Public WS publication requires a message DTO.');
    }
}

export async function publishRallarServerWsMessage(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    try {
        const result = await publishRallarServerWsMessageWithResult(input);
        recordRallarTiming({
            sink: input.timing,
            event: {
                component: 'rallar-ws-publication',
                operation: 'route-publish',
                details: {
                    msgId: input.message.id.msgId,
                    messageTopicId: input.message.route.topicId,
                    fanout: result.fanout,
                    verdict: result.verdict?.kind ?? result.status,
                    verdictReason: result.verdict && 'reason' in result.verdict ? result.verdict.reason : undefined,
                    keyTopicId: result.entry?.key.topicId,
                    keyResourceId: result.entry?.key.resourceId,
                    keyContextId: result.entry?.key.contextId,
                    recipientCount: result.recipientCount,
                    sentCount: result.sentCount,
                    failedCount: result.failedCount
                }
            },
            status: result.status === 'failed' ? 'error' : 'ok',
            durationMs: 0
        });
        return result;
    }
    catch (error) {
        recordRallarTiming({
            sink: input.timing,
            event: {
                component: 'rallar-ws-publication',
                operation: 'route-publish',
                details: {
                    msgId: input.message.id.msgId,
                    messageTopicId: input.message.route.topicId,
                    verdict: 'threw'
                }
            },
            status: 'error',
            durationMs: 0
        });
        throw error;
    }
}

async function publishRallarServerWsMessageWithResult(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    const normalized = input.fanout === 'none' ? undefined : input.service.resolveOutboundPolicy(input.message);
    const fanout = input.fanout ?? (normalized && shouldAwaitALRoute(normalized.effective) ? 'outbox' : 'live-only');
    const publication: ResolvedRallarServerWsPublication = { ...input, fanout };
    let audience = publication.audience;
    if (audience === undefined) {
        try {
            audience = await readRallarServerWsPublicationAudience({
                message: publication.message,
                fanout: publication.fanout,
                origin: publication.origin,
                authorizeRoomMessage: publication.authorizeRoomMessage,
                readServerPublishAudience: publication.readServerPublishAudience
            });
        }
        catch (error) {
            // A public publish reports a failed operation; admitted/proxy dispatch keeps its retry signal.
            if (publication.origin === 'proxy' || publication.origin === 'admitted') {
                throw error;
            }
            return toFailedPublishResult(publication, error instanceof Error ? error.message : String(error));
        }
    }
    return await publishAuthorizedRallarServerWsMessage({ ...publication, audience }, normalized);
}

async function publishAuthorizedRallarServerWsMessage(
    input: ResolvedRallarServerWsPublication,
    normalized: ALQosNormalizationResult | undefined
): Promise<RallarServerWsPublishResult> {
    if (input.message.targets?.mode === 'unicast' && validateALOutboundRecipientScope(input.inboundScope).length > 0) {
        return { fanout: input.fanout, status: 'skipped', message: input.message, sentCount: 0, entries: [] };
    }
    if (input.fanout === 'none') {
        return await publishRallarServerWsFanout(input);
    }
    const targets = input.message.targets;
    const roomTarget = targets?.mode === 'multicast' ||
        (targets?.mode === 'broadcast' && targets.scope === 'room');
    if (input.livePublication && roomTarget && !readALTargetGroupRef(input.message)) {
        return toFailedPublishResult(input, 'Room publication requires a full group reference.');
    }
    if (input.livePublication && roomTarget && !input.audience) {
        return toFailedPublishResult(input, 'Room publication has no authorized frozen audience.');
    }
    if (input.audience && !isAuthorizedRoomAudience(input.message, input.audience, input.nowEpochMs)) {
        return toFailedPublishResult(input, 'Room publication audience does not authorize the final message targets.');
    }
    const policy = normalized ?? input.service.resolveOutboundPolicy(input.message);
    if (policy.unmetRequirements.length > 0) {
        return toFailedPublishResult(input, policy.unmetRequirements.join('; '));
    }
    const requiresDurableWork = shouldAwaitALRoute(policy.effective);
    if (policy.effective.delivery.algo !== 'best-effort' && !requiresDurableWork) {
        return toFailedPublishResult(input, 'Effective delivery requires durable outbound work.');
    }
    if (requiresDurableWork && input.fanout !== 'outbox') {
        return toFailedPublishResult(input, 'Explicit live-only fanout is incompatible with durable outbound work.');
    }
    if (!requiresDurableWork && input.livePublication) {
        return await publishRallarServerLiveWsNotice(input, policy.effective);
    }
    return await publishRallarServerWsFanout(input);
}

function toFailedPublishResult(input: ResolvedRallarServerWsPublication, reason: string): RallarServerWsPublishResult {
    return { fanout: input.fanout, status: 'failed', message: input.message, entries: [], reason };
}
