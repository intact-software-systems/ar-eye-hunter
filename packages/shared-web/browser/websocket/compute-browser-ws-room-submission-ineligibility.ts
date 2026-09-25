import type { GroupSnapshot } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import {
    isRoomScopedALMessage,
    readALTargetGroupRef,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import {
    AppTopics,
    type AuthSession,
    type ClientInfo
} from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { RALLAR_AL_CONTROL_TOPIC_ID } from '@shared/api/rallar-validation.ts';

const systemTopics = new Set<string>([...Object.values(AppTopics), RALLAR_AL_CONTROL_TOPIC_ID]);

export interface BrowserWsRoomSubmissionInput {
    readonly message: ALMessage;
    readonly client: ClientInfo;
    readonly currentSession: AuthSession | undefined;
    readonly snapshot: GroupSnapshot | undefined;
    readonly nowMs: number;
}

export function requiresBrowserWsRoomPresence(message: ALMessage): boolean {
    // These exact protocol identities belong to middleware, including room-shaped AL controls.
    // CRDT application topics are intentionally not exempt from sender presence.
    return isRoomScopedALMessage(message) && !systemTopics.has(message.route.topicId) &&
        !isALControlTypeId(message.payload.typeId);
}

/** A local prerequisite for room data, never a replacement for server authorization. */
export function computeBrowserWsRoomSubmissionIneligibility(input: BrowserWsRoomSubmissionInput): string | undefined {
    const { message, client, currentSession, snapshot, nowMs } = input;
    if (
        currentSession?.sessionId !== client.sessionId || currentSession.clientId !== client.clientId ||
        message.id.senderId !== client.sessionId
    ) {
        return 'Room submission is awaiting its original authenticated session';
    }
    const ref = readALTargetGroupRef(message);
    if (!ref || !snapshot || !isSameGroupRef(ref, snapshot.group)) {
        return 'Room submission is awaiting its scoped authority observation';
    }
    if (
        snapshot.group.status !== 'active' ||
        (snapshot.group.expiresAtEpochMs !== null && snapshot.group.expiresAtEpochMs <= nowMs)
    ) {
        return 'Room submission requires a live room';
    }
    const session = snapshot.activeSessions.find((candidate) => candidate.sessionId === client.sessionId);
    if (
        !session || !isSameGroupRef(ref, session) || session.principalId !== client.clientId ||
        session.status !== 'active' || session.disconnectedAtEpochMs !== null || session.expiresAtEpochMs <= nowMs
    ) {
        return 'Room submission is awaiting live sender presence';
    }
    const member = snapshot.members.find((candidate) => candidate.principalId === client.clientId);
    if (!member || !isSameGroupRef(ref, member) || member.status !== 'active') {
        return 'Room submission requires active sender membership';
    }
    return undefined;
}
