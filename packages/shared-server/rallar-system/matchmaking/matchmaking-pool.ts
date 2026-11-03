import type { GroupRef } from '@shared/api/group-types.ts';
import type { MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import type { MatchmakingEndedReason } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { MatchmakingPartySearch, MatchmakingPartyStart } from './matchmaking-party-search.ts';

export interface MatchmakingActor {
    readonly principalId: string;
    readonly sessionId: string;
    readonly sessionIssuedAtEpochMs: number;
    readonly sessionExpiresAtEpochMs: number;
}

export interface MatchmakingSearch extends MatchmakingActor {
    readonly searchId: string;
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export interface MatchmakingParticipant extends MatchmakingSearch {
    readonly confirmedAtEpochMs: number | null;
}

export interface MatchmakingProposal {
    readonly roomRef: GroupRef;
    readonly leaderPrincipalId: string;
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly participants: readonly MatchmakingParticipant[];
}

export interface MatchmakingPool {
    readonly scope: StateScope;
    readonly searching: readonly MatchmakingSearch[];
    readonly proposals: readonly MatchmakingProposal[];
}

export interface MatchmakingFinished extends MatchmakingSearch {
    readonly completedAtEpochMs: number;
    readonly reason: MatchmakingEndedReason | 'matched';
    readonly roomRef: GroupRef | null;
    readonly leaderPrincipalId: string | null;
}

export type MatchmakingIntent =
    | Readonly<{ action: 'expire'; }>
    | (
        & MatchmakingActor
        & Readonly<
            { action: 'start-party'; searchId: string; capturedAtEpochMs: number; party: MatchmakingPartyStart; }
        >
    )
    | (
        & MatchmakingActor
        & Readonly<{
            action: 'start' | 'cancel' | 'confirm';
            searchId: string;
            capturedAtEpochMs: number;
        }>
    );

export interface MatchmakingInput {
    readonly partySearches: readonly MatchmakingPartySearch[];
    readonly pool: MatchmakingPool;
    readonly policy: MatchmakingPolicy;
    readonly nowEpochMs: number;
    readonly command: MatchmakingIntent;
}

export interface MatchmakingTransition {
    readonly partySearches: readonly MatchmakingPartySearch[];
    readonly pool: MatchmakingPool;
    readonly finished: readonly MatchmakingFinished[];
    readonly admission: MatchmakingProposal | null;
    readonly searchId: string | null;
    readonly rejection: 'search-not-current' | 'search-capacity' | null;
}

export interface MatchmakingInvalidationInput {
    readonly pool: MatchmakingPool;
    readonly partySearches: readonly MatchmakingPartySearch[];
    readonly nowEpochMs: number;
    readonly principalIds: readonly string[];
}

export function finishMatchmakingSearch(
    search: MatchmakingSearch,
    reason: MatchmakingFinished['reason'],
    now: number
): MatchmakingFinished {
    return {
        searchId: search.searchId,
        principalId: search.principalId,
        sessionId: search.sessionId,
        sessionIssuedAtEpochMs: search.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: search.sessionExpiresAtEpochMs,
        createdAtEpochMs: search.createdAtEpochMs,
        expiresAtEpochMs: search.expiresAtEpochMs,
        completedAtEpochMs: now,
        reason,
        roomRef: null,
        leaderPrincipalId: null
    };
}

export function activeMatchmakingSearches(pool: MatchmakingPool): readonly MatchmakingSearch[] {
    return [...pool.searching, ...pool.proposals.flatMap((proposal) => proposal.participants)];
}
