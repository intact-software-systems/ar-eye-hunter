import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALSequenceMintTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { hasALDeliveryDurableWork } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import type { LiveWsInboundReference } from '../../queue-pubsub/live-ws-notice.ts';
import { publishRallarServerLiveWsNotice } from './publish-rallar-server-live-ws-notice.ts';
import {
    isAuthorizedRoomAudience,
    readRallarServerWsPublicationAudience,
    resolveAuthorizedRoomSessionIds,
    type RallarServerWsPublicationAudience
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
import { validateRallarServerWsPublishScope } from './validate-rallar-server-ws-publish-scope.ts';

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
    readonly readServerPublishAudience?: RallarServerWsRouterOptions['readServerPublishAudience'];
    readonly inbound?: LiveWsInboundReference;
    readonly origin?: 'server' | 'proxy' | 'admitted';
    readonly authorizeRoomMessage?: RallarServerWsRouterOptions['authorizeRoomMessage'];
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
    if (input.audience !== undefined) {
        return await publishAuthorizedRallarServerWsMessage(input);
    }
    let audience: Either<string, RallarServerWsPublicationAudience>;
    try {
        audience = await readRallarServerWsPublicationAudience({
            message: input.message,
            fanout: input.fanout,
            origin: input.origin,
            authorizeRoomMessage: input.authorizeRoomMessage,
            readServerPublishAudience: input.readServerPublishAudience
        });
    }
    catch (error) {
        // A public publish reports a failed operation; admitted/proxy dispatch keeps its retry signal.
        if (input.origin === 'proxy' || input.origin === 'admitted') {
            throw error;
        }
        return toFailedPublishResult(input, error instanceof Error ? error.message : String(error));
    }
    if (audience.left !== undefined) {
        return toFailedPublishResult(input, audience.left);
    }
    return await publishAuthorizedRallarServerWsMessage({ ...input, audience: audience.right!.frozen });
}

/** The topic's fanout alone picks the carrier; the message's QoS never moves it to another one. */
async function publishAuthorizedRallarServerWsMessage(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    const scopeIssues = validateRallarServerWsPublishScope(input);
    if (scopeIssues.length > 0) {
        return toFailedPublishResult(input, scopeIssues.join('; '));
    }
    if (isUnmintedServerSequence(input)) {
        return toFailedPublishResult(
            input,
            'A server publication that names an ordering key without a sequence needs the outbox fanout, which mints it.'
        );
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
    if (input.fanout === 'live-only' && input.livePublication) {
        return await publishRallarServerLiveWsNotice(
            input,
            input.service.resolveOutboundPolicy(input.message).effective
        );
    }
    return await publishRallarServerWsFanout(input);
}

async function publishRallarServerWsFanout(
    input: PublishRallarServerWsMessageInput
): Promise<RallarServerWsPublishResult> {
    switch (input.fanout) {
        case 'none':
            return { fanout: 'none', status: 'none', message: input.message, sentCount: 0, entries: [] };
        case 'outbox': {
            const result = await input.service.enqueueOutboxIfAbsent(input.message, {
                admittedAudience: toAdmittedAudience(input),
                recipientScope:
                    input.message.targets?.mode === 'unicast' && input.message.targets.groupRef === undefined
                        ? input.inboundScope ?? undefined
                        : undefined
            });
            if (hasALDeliveryDurableWork(result.verdict)) {
                input.wakeOutbox?.();
            }
            return toRallarServerWsOutboxPublishResult(input.fanout, result);
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

/** Only the outbox admission mints the server's own sequence; any other fanout would send the keyed message unsequenced. */
function isUnmintedServerSequence(input: PublishRallarServerWsMessageInput): boolean {
    return input.fanout !== 'outbox' && input.message.id.senderId === input.service.name &&
        toALSequenceMintTrackKey(input.message) !== undefined;
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
