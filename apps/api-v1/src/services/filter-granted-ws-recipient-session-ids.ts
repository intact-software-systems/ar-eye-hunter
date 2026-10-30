import {
    computeRoomPublicationAdmission,
    computeRoomPublicationAudience,
    type RoomPublicationAdmission
} from '@shared-server/rallar-system/websocket/room-publication/compute-room-publication-admission.ts';
import type { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import type { RallarServerWsRoomAudience } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { CapturedWsRecipientEligibilityInputDto } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';

export interface FilterGrantedWsRecipientSessionIdsInput extends CapturedWsRecipientEligibilityInputDto {
    /** The socket and scope eligibility filter's result for the same candidates. */
    readonly durableEligibleSessionIds: readonly string[];
    readonly grantedTopics: WsGrantedTopicSet;
    /** The id the WS server publishes its own rows under: such a row re-checks the subscribe half alone (D496). */
    readonly serverPeerId: string;
    /** The version-probed snapshot read: durable authority as of this step's probe, never a TTL cache. */
    readonly readCurrentSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly nowEpochMs: number;
}

/**
 * The D498 re-check of one dispatch step. A `members` row keeps the socket and scope filter's result. A granted row is
 * re-admitted on the probed snapshot: its publisher must still hold `publish`, and only durable-eligible sessions that
 * still hold `subscribe` stay. A failed read rejects, so the step sends nothing and its row retries; a room the read
 * finds no current snapshot of is a fact, not a failure: the row reaches nobody and completes, charging nothing.
 */
export async function filterGrantedWsRecipientSessionIds(
    input: FilterGrantedWsRecipientSessionIdsInput
): Promise<readonly string[]> {
    const { message, durableEligibleSessionIds } = input;
    const groupRef = readALTargetGroupRef(message);
    if (!input.grantedTopics.has(message.route.topicId)) {
        return durableEligibleSessionIds;
    }
    if (groupRef === undefined || message.targets === undefined) {
        return [];
    }
    const snapshot = await input.readCurrentSnapshot(groupRef);
    if (snapshot === undefined || !isSameGroupRef(snapshot.group, groupRef)) {
        return [];
    }
    const audience = readGrantedRowAudience(input, snapshot, { ...message, targets: message.targets });
    const audienceSessionIds = new Set(audience.right?.sessions.map((session) => session.sessionId) ?? []);
    return durableEligibleSessionIds.filter((sessionId) => audienceSessionIds.has(sessionId));
}

function readGrantedRowAudience(
    input: FilterGrantedWsRecipientSessionIdsInput,
    snapshot: GroupSnapshot,
    message: ALMessage & Pick<Required<ALMessage>, 'targets'>
): Either<RoomPublicationAdmission.Refusal, RallarServerWsRoomAudience> {
    const admission = {
        snapshot,
        topic: { topicId: message.route.topicId, participation: 'granted', serverProducerIds: [] },
        message,
        nowEpochMs: input.nowEpochMs
    } as const;
    if (message.id.senderId === input.serverPeerId) {
        return Either.ofRight(computeRoomPublicationAudience(admission));
    }
    const origin = snapshot.activeSessions.find((session) => session.sessionId === message.id.senderId);
    return origin === undefined
        ? Either.ofLeft({ code: 'no-publish-grant', logMessage: `Publisher ${message.id.senderId} has left the room.` })
        : computeRoomPublicationAdmission({
            ...admission,
            publisher: { kind: 'session', sessionId: origin.sessionId, principalId: origin.principalId }
        });
}
