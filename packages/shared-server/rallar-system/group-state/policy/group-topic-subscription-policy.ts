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
    readonly clientSession: ClientSession | null;
    readonly connectionGenerationId: string;
    readonly nowEpochMs: number;
}

/**
 * An active member subscribes one of its live sessions, asserted by that session's current connection generation, to
 * a topic it holds effective subscribe on.
 */
export function canSubscribeGroupTopic(input: CanSubscribeGroupTopicInput): GroupPolicyResult {
    if (input.member?.status !== 'active') {
        return denyGroupPolicy('member-not-active', 'Only an active member subscribes to a topic.');
    }
    if (!isLiveClientSession(input.clientSession, input.nowEpochMs)) {
        return denyGroupPolicy('no-live-session', 'The subscribing session is not live.');
    }
    if (input.clientSession.generationId !== input.connectionGenerationId) {
        return denyGroupPolicy('stale-generation', 'The asserted connection generation is not the live one.');
    }
    return resolveMemberPublicationPermissions(input.member, input.grant, input.topicId).subscribe
        ? GROUP_POLICY_ALLOWED
        : denyGroupPolicy('no-subscribe-grant', 'The principal holds no effective subscribe on the topic.');
}

export function isLiveClientSession(session: ClientSession | null, nowEpochMs: number): session is ClientSession {
    return session !== null && session.status === 'active' && session.expiresAtEpochMs > nowEpochMs;
}
