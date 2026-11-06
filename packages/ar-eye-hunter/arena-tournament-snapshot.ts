import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentMatchBinding } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { decodeTournamentArenaCheckpoint } from './decode-tournament-arena-checkpoint.ts';
import { AR_EYE_TOURNAMENT_RULES_ID, type TournamentArena } from './tournament-arena.ts';

/** Native game state for authorized room members; authentication and private attempt rows never leave the owner. */
export interface ArenaTournamentSnapshot {
    readonly binding: TournamentMatchBinding;
    readonly status: 'scheduled' | 'playing' | 'finished' | 'cancelled';
    readonly attemptRevision: number;
    readonly observedAtEpochMs: number;
    readonly state: TournamentArena | null;
}

export function decodeArenaTournamentSnapshot(value: unknown): ArenaTournamentSnapshot {
    const snapshot = requireRecord(value, 'Arena tournament snapshot');
    requireExactKeys(
        snapshot,
        ['binding', 'status', 'attemptRevision', 'observedAtEpochMs', 'state'],
        'Arena tournament snapshot'
    );
    const binding = decodeTournamentMatchBinding(snapshot.binding);
    const status = requireOneOf(
        snapshot.status,
        ['scheduled', 'playing', 'finished', 'cancelled'],
        'Arena tournament status'
    );
    if (binding.rulesId !== AR_EYE_TOURNAMENT_RULES_ID) {
        throw new TypeError('Unsupported arena tournament rules');
    }
    requireEpoch(snapshot.attemptRevision, 'Arena tournament attempt revision');
    requireEpoch(snapshot.observedAtEpochMs, 'Arena tournament observation');
    if (snapshot.state === null) {
        return {
            binding,
            status,
            attemptRevision: snapshot.attemptRevision,
            observedAtEpochMs: snapshot.observedAtEpochMs,
            state: null
        };
    }
    const state = requireRecord(snapshot.state, 'Arena tournament state');
    const arena = requireRecord(state.arena, 'Arena tournament simulation');
    requireEpoch(state.startedAtEpochMs, 'Arena tournament start');
    if (typeof arena.seed !== 'number' || !Number.isSafeInteger(arena.seed)) {
        throw new TypeError('Arena tournament seed is invalid');
    }
    return {
        binding,
        status,
        attemptRevision: snapshot.attemptRevision,
        observedAtEpochMs: snapshot.observedAtEpochMs,
        state: decodeTournamentArenaCheckpoint(state, {
            gameId: binding.gameId,
            principalIds: binding.principalIds,
            startedAtEpochMs: state.startedAtEpochMs,
            seed: arena.seed,
            durationMs: 60000
        })
    };
}
