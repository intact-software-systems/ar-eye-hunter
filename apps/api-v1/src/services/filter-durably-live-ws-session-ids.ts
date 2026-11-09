import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { readALPrincipalBroadcastTarget } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import {
    filterGrantedWsRecipientSessionIds,
    type FilterGrantedWsRecipientSessionIdsInput
} from './filter-granted-ws-recipient-session-ids.ts';

export interface FilterDurablyLiveWsSessionIdsInput
    extends Omit<FilterGrantedWsRecipientSessionIdsInput, 'durableEligibleSessionIds'> {
    /** The principal's live session rows, or `undefined` when the principal is not active in the scope. */
    readonly readPrincipalLiveSessionIds: (ref: ClientPrincipalRef) => Promise<readonly string[] | undefined>;
}

/**
 * The dequeue's half of the D498 re-check: the candidates with a live connection generation anywhere, in candidate
 * order; the local half is the socket filter at send. A granted row keeps the candidates whose live subscription
 * asserts the generation it captured; a room row the candidates the room's live generations name, nobody when the room
 * has no current snapshot; a principal row the principal's live sessions. A row naming neither keeps its candidates:
 * no durable fact names its sessions, so the send filter and the retry decide.
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
        return authority === undefined
            ? []
            : candidateSessionIds.filter((sessionId) => Object.hasOwn(authority.liveSessionGenerations, sessionId));
    }
    const principalRef = readALPrincipalBroadcastTarget(message);
    if (principalRef !== undefined) {
        const live = new Set(await input.readPrincipalLiveSessionIds(principalRef));
        return candidateSessionIds.filter((sessionId) => live.has(sessionId));
    }
    return candidateSessionIds;
}
