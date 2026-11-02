import type { GroupRef } from '@shared/api/group-types.ts';
import type { MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import type { MatchmakingEndedReason } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import type { StateScope } from '@shared/api/state-types.ts';

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
        & Readonly<{
            action: 'start' | 'cancel' | 'confirm';
            searchId: string;
            capturedAtEpochMs: number;
        }>
    );

export interface MatchmakingInput {
    readonly pool: MatchmakingPool;
    readonly policy: MatchmakingPolicy;
    readonly nowEpochMs: number;
    readonly command: MatchmakingIntent;
}

export interface MatchmakingTransition {
    readonly pool: MatchmakingPool;
    readonly finished: readonly MatchmakingFinished[];
    readonly admission: MatchmakingProposal | null;
    readonly searchId: string | null;
    readonly rejection: 'search-not-current' | 'search-capacity' | null;
}
