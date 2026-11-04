import { requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentMatchBinding } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';

export interface RelicTournamentParticipation {
    readonly binding: TournamentMatchBinding;
    readonly status: 'playing' | 'finished' | 'cancelled';
}

export const RELIC_TOURNAMENT_RULES_ID = 'relic-native-10-rounds-v1';

/** Tournament hunters belong to accounts so a new session resumes the same competitor. */
export function relicPlayerId(
    tournament: TournamentMatchBinding | null,
    actor: { readonly clientId: string; readonly sessionId: string; }
): string {
    return tournament === null ? actor.sessionId : actor.clientId;
}

export function isRelicTournamentParticipation(
    value: unknown,
    gameId: string,
    roomId: string
): value is RelicTournamentParticipation | null {
    if (value === null) {
        return true;
    }
    try {
        const participation = requireRecord(value, 'Relic tournament participation');
        requireExactKeys(participation, ['binding', 'status'], 'Relic tournament participation');
        requireOneOf(participation.status, ['playing', 'finished', 'cancelled'], 'Relic tournament attempt status');
        const binding = decodeTournamentMatchBinding(participation.binding);
        return binding.gameId === gameId && binding.roomRef.groupId === roomId &&
            binding.rulesId === RELIC_TOURNAMENT_RULES_ID;
    }
    catch {
        return false;
    }
}
