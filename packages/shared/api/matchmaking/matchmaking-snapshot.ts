import type { GroupRef } from '../group-types.ts';
import type { StateScope } from '../state-types.ts';

export type MatchmakingEndedReason =
    | 'search-timeout'
    | 'confirmation-timeout'
    | 'cancelled'
    | 'declined'
    | 'admission-denied';

export interface MatchmakingPlayer {
    readonly principalId: string;
    readonly confirmed: boolean;
}

export type MatchmakingState =
    | Readonly<{ status: 'idle'; }>
    | Readonly<{ status: 'searching'; searchId: string; expiresAtEpochMs: number; }>
    | Readonly<{
        status: 'confirming';
        searchId: string;
        expiresAtEpochMs: number;
        leaderPrincipalId: string;
        players: readonly MatchmakingPlayer[];
    }>
    | Readonly<{ status: 'matched'; searchId: string; roomRef: GroupRef; leaderPrincipalId: string; }>
    | Readonly<{ status: 'ended'; searchId: string; reason: MatchmakingEndedReason; }>;

export interface MatchmakingSnapshot {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly observedAtEpochMs: number;
    readonly state: MatchmakingState;
}
