import type { PrincipalSessionIds } from '@shared-server/rallar-system/websocket/read-principal-session-ids.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { readALPrincipalBroadcastTarget } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import {
    filterGrantedWsRecipientSessionIds,
    type FilterGrantedWsRecipientSessionIdsInput
} from './filter-granted-ws-recipient-session-ids.ts';

export interface FilterDurablyLiveWsSessionIdsInput
    extends Omit<FilterGrantedWsRecipientSessionIdsInput, 'durableEligibleSessionIds'> {
    /** The principal's stored session rows and its live ones, or `undefined` when no principal row exists in the scope. */
    readonly readPrincipalSessions: (ref: ClientPrincipalRef) => Promise<PrincipalSessionIds | undefined>;
}

/**
 * The dequeue's half of the D498 re-check: the candidates with a live connection generation anywhere, in candidate
 * order; the local half is the socket filter at send. A granted row keeps the candidates whose live subscription
 * asserts the generation it captured; a room row the candidates the room's live generations name, nobody when the room
 * has no current snapshot or the authority read answers for another room; a principal row the principal's own
 * sessions that are live (none while the principal is not active) and every candidate that is not one of its stored
 * sessions (a co-member's, which no fact of the row judges), every candidate when no principal row exists. A row
 * naming neither keeps its candidates: no durable fact names its sessions, so the send filter and the retry decide.
 */
export async function filterDurablyLiveWsSessionIds(
    input: FilterDurablyLiveWsSessionIdsInput
): Promise<readonly string[]> {
    const { message, candidateSessionIds } = input;
    if (input.grantedTopics.has(message.route.topicId)) {
        return await filterGrantedWsRecipientSessionIds({ ...input, durableEligibleSessionIds: candidateSessionIds });
    }
    const groupRef = readALTargetGroupRef(message);
    if (groupRef !== undefined) {
        const authority = await input.readPublicationAuthority(groupRef, message.route.topicId);
        return authority === undefined || !isSameGroupRef(authority.snapshot.group, groupRef)
            ? []
            : candidateSessionIds.filter((sessionId) => Object.hasOwn(authority.liveSessionGenerations, sessionId));
    }
    const principalRef = readALPrincipalBroadcastTarget(message);
    if (principalRef !== undefined) {
        const sessions = await input.readPrincipalSessions(principalRef);
        if (sessions === undefined) {
            return candidateSessionIds;
        }
        const own = new Set(sessions.sessionIds);
        const live = new Set(sessions.liveSessionIds);
        return candidateSessionIds.filter((sessionId) => !own.has(sessionId) || live.has(sessionId));
    }
    return candidateSessionIds;
}
