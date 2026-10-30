import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { resolveGroupPublicationPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import { requireActiveGroup } from '../../group-state/policy/group-policy-primitives.ts';
import type {
    RallarServerWsRoomAudience,
    RallarServerWsTopicAccess
} from '../router/rallar-server-ws-router-contracts.ts';
import { toAuthorizedRoomAudience, type AuthorizedRoomAudienceMessage } from './to-authorized-room-audience.ts';

export namespace RoomPublicationAdmission {
    export type Publisher =
        | Readonly<{ kind: 'session'; sessionId: string; principalId: string; }>
        | Readonly<{ kind: 'server-producer'; producerId: string | undefined; }>;

    export interface Input {
        /** The probed snapshot, grants included. */
        readonly snapshot: GroupSnapshot;
        readonly topic: RallarServerWsTopicAccess & Readonly<{ topicId: string; }>;
        readonly publisher: Publisher;
        readonly message: AuthorizedRoomAudienceMessage;
        readonly nowEpochMs: number;
    }

    export type RefusalCode = 'no-publish-grant' | 'topic-not-granted' | 'unsupported';

    export interface Refusal {
        readonly code: RefusalCode;
        readonly logMessage: string;
    }
}

/**
 * The one WS publication decision (D487): a `members` topic reaches the room's authorized audience; a `granted` topic
 * admits a session holding effective `publish` or a listed server producer, and reaches only the sessions of the
 * principals holding effective `subscribe`. A group that is not active (archived, deleted, expired) holds no effective
 * grant (D485). Targeting and the leader receipt only narrow either audience.
 */
export function computeRoomPublicationAdmission(
    input: RoomPublicationAdmission.Input
): Either<RoomPublicationAdmission.Refusal, RallarServerWsRoomAudience> {
    if (input.topic.participation === 'members') {
        return Either.ofRight(computeRoomPublicationAudience(input));
    }
    const refusal = resolveGrantedPublisherRefusal(input, input.topic.serverProducerIds);
    return refusal === undefined ? Either.ofRight(computeRoomPublicationAudience(input)) : Either.ofLeft(refusal);
}

/** The subscribe half of the decision, which a dispatch step re-reads for a row the server itself published. */
export function computeRoomPublicationAudience(
    input: Omit<RoomPublicationAdmission.Input, 'publisher'>
): RallarServerWsRoomAudience {
    const audience = toAuthorizedRoomAudience(input.snapshot, input.message, input.nowEpochMs);
    if (input.topic.participation === 'members') {
        return audience;
    }
    const { snapshot, topic } = input;
    if (requireActiveGroup(snapshot.group, input.nowEpochMs) !== undefined) {
        return { ...audience, sessions: [] };
    }
    const subscribers = new Set(
        snapshot.publicationGrants
            .map((grant) => grant.principalId)
            .filter((principalId) => resolveGroupPublicationPermissions(snapshot, principalId, topic.topicId).subscribe)
    );
    return { ...audience, sessions: audience.sessions.filter((session) => subscribers.has(session.principalId)) };
}

/** A granted topic is grants of one room: a publication that names no room's GroupRef is refused (§5.2). */
export function toUngroupedRoomPublicationRefusal(topicId: string): RoomPublicationAdmission.Refusal {
    return { code: 'unsupported', logMessage: `Granted WS topic ${topicId} needs a room GroupRef.` };
}

function resolveGrantedPublisherRefusal(
    input: RoomPublicationAdmission.Input,
    serverProducerIds: readonly string[]
): RoomPublicationAdmission.Refusal | undefined {
    const { topic, publisher } = input;
    if (readALTargetGroupRef(input.message) === undefined) {
        return toUngroupedRoomPublicationRefusal(topic.topicId);
    }
    if (publisher.kind === 'server-producer') {
        return publisher.producerId !== undefined && serverProducerIds.includes(publisher.producerId)
            ? undefined
            : {
                code: 'topic-not-granted',
                logMessage: `Server producer ${publisher.producerId ?? '(none)'} may not publish on ${topic.topicId}.`
            };
    }
    return requireActiveGroup(input.snapshot.group, input.nowEpochMs) === undefined &&
            resolveGroupPublicationPermissions(input.snapshot, publisher.principalId, topic.topicId).publish
        ? undefined
        : {
            code: 'no-publish-grant',
            logMessage: `Session ${publisher.sessionId} holds no publish grant on ${topic.topicId}.`
        };
}
