import type { ClientSession } from '@shared/api/client-types.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import {
    resolveMemberPublicationPermissions,
    type GroupPublicationGrant
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupMember } from '@shared/api/group-types.ts';

import { denyGroupPolicy, GROUP_POLICY_ALLOWED } from './group-policy-result.ts';

export interface CanSubscribeGroupTopicInput {
    readonly member: GroupMember | null;
    readonly grant: GroupPublicationGrant | null;
    readonly topicId: string;
    /** The session's active client-state rows, one per client instance holding it. */
    readonly clientSessions: readonly ClientSession[];
    readonly connectionGenerationId: string;
    readonly nowEpochMs: number;
}

/**
 * An active member subscribes one of its live sessions, asserted by the current connection generation of one of the
 * session's live client-state rows, to a topic it holds effective subscribe on.
 */
export function canSubscribeGroupTopic(input: CanSubscribeGroupTopicInput): GroupPolicyResult {
    if (input.member?.status !== 'active') {
        return denyGroupPolicy('member-not-active', 'Only an active member subscribes to a topic.');
    }
    const live = input.clientSessions.filter((session) => isLiveClientSession(session, input.nowEpochMs));
    if (live.length === 0) {
        return denyGroupPolicy('no-live-session', 'The subscribing session is not live.');
    }
    if (!holdsLiveGeneration(live, input.connectionGenerationId, input.nowEpochMs)) {
        return denyGroupPolicy('stale-generation', 'The asserted connection generation is not a live one.');
    }
    return resolveMemberPublicationPermissions(input.member, input.grant, input.topicId).subscribe
        ? GROUP_POLICY_ALLOWED
        : denyGroupPolicy('no-subscribe-grant', 'The principal holds no effective subscribe on the topic.');
}

/** True when a live client-state row of the session runs at the generation. */
export function holdsLiveGeneration(
    sessions: readonly ClientSession[],
    generationId: string,
    nowEpochMs: number
): boolean {
    return sessions.some((session) =>
        isLiveClientSession(session, nowEpochMs) && session.generationId === generationId
    );
}

function isLiveClientSession(session: ClientSession, nowEpochMs: number): boolean {
    return session.status === 'active' && session.expiresAtEpochMs > nowEpochMs;
}
