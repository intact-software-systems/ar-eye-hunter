import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { shouldAwaitALRoute, type ALQosNormalizationResult } from '@shared/al-contracts/al-policy.ts';
import { hasALDeliveryDurableWork } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { validateALOutboundRecipientScope } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { LiveWsInboundReference } from '../../queue-pubsub/live-ws-notice.ts';
import { publishRallarServerLiveWsNotice } from './publish-rallar-server-live-ws-notice.ts';
import {
    isAuthorizedRoomAudience,
    readRallarServerWsPublicationAudience,
    resolveAuthorizedRoomSessionIds
} from './rallar-server-ws-publication-audience.ts';
import {
    toRallarServerWsLivePublishResult,
    toRallarServerWsOutboxPublishResult
} from './rallar-server-ws-publish-result.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishInputDto,
    RallarServerWsPublishResult,
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions
} from './rallar-server-ws-router-contracts.ts';

export interface PublishRallarServerWsMessageInput {
    readonly service: WsQueueBoxServerService;
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

async function publishRallarServerWsFanout(
    input: ResolvedRallarServerWsPublication
): Promise<RallarServerWsPublishResult> {
    switch (input.fanout) {
        case 'none':
            return { fanout: 'none', status: 'none', message: input.message, sentCount: 0, entries: [] };
        case 'outbox': {
            const result = await input.service.enqueueOutboxIfAbsent(
                input.message,
                toAdmittedAudience(input),
                input.message.targets?.mode === 'unicast' ? input.inboundScope ?? undefined : undefined
            );
            if (hasALDeliveryDurableWork(result.verdict)) {
                input.wakeOutbox?.();
            }
            return toRallarServerWsOutboxPublishResult(input.message, input.fanout, result);
        }
        case 'live-only': {
            const groupRef = readALTargetGroupRef(input.message);
            const result = input.service.sendToTargetsWithResult({
                message: input.message,
                recipientSessionIds: input.audience === undefined ? undefined : resolveAuthorizedRoomSessionIds({
                    message: input.message,
                    audience: input.audience,
                    admittedPeerIds: input.admittedPeerIds,
                    nowEpochMs: input.nowEpochMs
                }),
                admittedPeerIds: input.admittedPeerIds,
                inboundScope: input.inboundScope,
                recipientScope: input.audience && groupRef
                    ? { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId }
                    : undefined
            });
            if (result.status === 'no-recipients') {
                console.warn(`Rallar server WS topic had no recipients: ${input.message.route.topicId}`);
            }
            return toRallarServerWsLivePublishResult(input.message, input.fanout, result);
        }
    }
}

function toFailedPublishResult(input: ResolvedRallarServerWsPublication, reason: string): RallarServerWsPublishResult {
    return { fanout: input.fanout, status: 'failed', message: input.message, entries: [], reason };
}

/**
 * The sessions the live branch would address, handed to the outbox beside the message: the server's own
 * outbound owner sends to that audience and its pending row expects it, never the sessions that happen to
 * be connected to the instance that dequeues it (D24, D43). The wire message stays as the origin sent it,
 * so a room larger than the collection limit still fans out.
 */
function toAdmittedAudience(input: ResolvedRallarServerWsPublication): readonly string[] | undefined {
    const { message, audience, admittedPeerIds } = input;
    return audience === undefined
        ? undefined
        : resolveAuthorizedRoomSessionIds({ message, audience, admittedPeerIds, nowEpochMs: input.nowEpochMs });
}
