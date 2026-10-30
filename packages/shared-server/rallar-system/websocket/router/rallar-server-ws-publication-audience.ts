import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { Either } from '@shared/resilience/Either.ts';
import { isGroupSnapshotSessionLive } from '../../presence/snapshot-presence.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { filterLiveWsRoomRecipientSessionIds } from '../../queue-pubsub/live-ws-audience.ts';
import {
    toUngroupedRoomPublicationRefusal,
    type RoomPublicationAdmission
} from '../room-publication/compute-room-publication-admission.ts';
import { authorizeRallarServerWsIngress } from './decode-rallar-server-ws-ingress.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsRoomAudience,
    RallarServerWsRouterOptions,
    RallarServerWsTopicAccess,
    RallarServerWsTopicDefinition
} from './rallar-server-ws-router-contracts.ts';

export interface ReadRallarServerWsPublicationAudienceInput {
    readonly message: ALMessage;
    readonly fanout: RallarServerWsFanout;
    readonly origin: 'server' | 'proxy' | 'admitted' | undefined;
    /** The message's own topic, so a proxy rule's result is authorized on the topic it publishes to (D497). */
    readonly definition: RallarServerWsTopicDefinition<JsonWireValue> | undefined;
    readonly topic: RallarServerWsTopicAccess;
    /** The session a proxy rule's result is published for: the sender of the message the rule transformed. */
    readonly senderId: string;
    readonly producerId: string | undefined;
    readonly authorizeRoomMessage: RallarServerWsRouterOptions['authorizeRoomMessage'];
    readonly readServerPublishAudience: RallarServerWsRouterOptions['readServerPublishAudience'];
}

/** The audience a publish is frozen to; none leaves its addressing to the wire targets. */
export interface RallarServerWsPublicationAudience {
    readonly frozen: RallarServerWsRoomAudience | undefined;
}

/**
 * Why a publish sends nothing: a granted topic refused a server or proxy publish that names no room, or a server
 * publish in a composition without a server publish audience reader, the topic refused a server producer, or the room
 * authorizer refused a proxy publish.
 */
export interface RallarServerWsPublicationRefusal {
    readonly reason: string;
    /**
     * The topic policy's refusal: `unsupported` for a server or proxy publish on a granted topic that names no room or a
     * server publish on one with no reader composed, or the server producer's refusal; undefined for a proxy publish the
     * room authorizer refused.
     */
    readonly refusal: RoomPublicationAdmission.RefusalCode | undefined;
}

export async function readRallarServerWsPublicationAudience(
    input: ReadRallarServerWsPublicationAudienceInput
): Promise<Either<RallarServerWsPublicationRefusal, RallarServerWsPublicationAudience>> {
    const groupRef = readALTargetGroupRef(input.message);
    if (input.origin !== 'admitted' && input.topic.participation === 'granted' && !groupRef) {
        const refusal = toUngroupedRoomPublicationRefusal(input.message.route.topicId);
        return Either.ofLeft({ reason: refusal.logMessage, refusal: refusal.code });
    }
    if (!groupRef || input.origin === 'admitted' || input.fanout === 'none') {
        return Either.ofRight({ frozen: undefined });
    }
    if (input.origin === 'proxy') {
        const authorization = await authorizeRallarServerWsIngress({
            message: input.message,
            definition: input.definition,
            topic: input.topic,
            senderId: input.senderId,
            authorizeRoomMessage: input.authorizeRoomMessage
        });
        return authorization.authorized
            ? Either.ofRight({ frozen: authorization.audience })
            : Either.ofLeft({ reason: authorization.logMessage, refusal: undefined });
    }
    if (input.topic.participation === 'granted' && input.readServerPublishAudience === undefined) {
        return Either.ofLeft({
            reason:
                `No server publish audience reader is composed for granted WS topic ${input.message.route.topicId}.`,
            refusal: 'unsupported'
        });
    }
    const audience = await input.readServerPublishAudience?.({
        message: input.message,
        topic: input.topic,
        producerId: input.producerId
    });
    return audience?.left === undefined
        ? Either.ofRight({ frozen: audience?.right })
        : Either.ofLeft({ reason: audience.left.logMessage, refusal: audience.left.code });
}

export interface ResolveAuthorizedRoomSessionIdsInput {
    readonly message: ALMessage;
    readonly audience: RallarServerWsRoomAudience;
    readonly admittedPeerIds: readonly string[] | undefined;
    readonly topic: RallarServerWsTopicAccess;
    readonly nowEpochMs: number;
}

/**
 * Admission fixes the addressed room audience of a members topic, so a session that left after it still receives
 * (D43); a granted topic's admitted sessions are narrowed to those the route's fresh audience still subscribes (D489).
 * Socket liveness remains a send-time decision.
 */
export function resolveAuthorizedRoomSessionIds(input: ResolveAuthorizedRoomSessionIdsInput): readonly string[] {
    const { message, audience, nowEpochMs } = input;
    if (!isAuthorizedRoomAudience(message, audience, nowEpochMs)) {
        return [];
    }
    const addressedSessionIds = input.admittedPeerIds === undefined
        ? audience.sessions
            .filter((session) => isGroupSnapshotSessionLive(session, nowEpochMs))
            .map((session) => session.sessionId)
        : toRouteAdmittedSessionIds(input.admittedPeerIds, audience, input.topic);
    return filterLiveWsRoomRecipientSessionIds(audience.targets, message.id.senderId, addressedSessionIds);
}

function toRouteAdmittedSessionIds(
    admittedPeerIds: readonly string[],
    audience: RallarServerWsRoomAudience,
    topic: RallarServerWsTopicAccess
): readonly string[] {
    return topic.participation === 'granted'
        ? admittedPeerIds.filter((sessionId) => Object.hasOwn(audience.recipientConnectionGenerationIds, sessionId))
        : admittedPeerIds;
}

export function isAuthorizedRoomAudience(
    message: ALMessage,
    audience: RallarServerWsRoomAudience,
    nowEpochMs: number
): boolean {
    return JSON.stringify(message.targets) === JSON.stringify(audience.targets) &&
        (message.constraints?.expiresAtMs === undefined || nowEpochMs <= message.constraints.expiresAtMs);
}
