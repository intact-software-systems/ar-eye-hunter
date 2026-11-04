import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeTournamentMatchBinding } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentMatchBinding, TournamentMatchResult } from '@shared/api/tournaments/tournament-types.ts';
import { deriveRallarMatchStandings } from '@shared/rallar-match/standings.ts';
import type { RallarMatchServerAuthorityDescriptor } from '@shared/rallar-match/types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { createRallarServerValidatedMatchResult } from '../../game/match-result.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';

export interface TournamentResultInput {
    readonly binding: TournamentMatchBinding;
    readonly authority: RallarMatchServerAuthorityDescriptor;
    readonly startedAtEpochMs: number;
    readonly finishedAtEpochMs: number;
    readonly scores: readonly [number, number];
}

/** Called only by a game's authoritative finalizer, never by a client result-upload route. */
export function createTournamentResult(input: TournamentResultInput): TournamentMatchResult {
    const binding = decodeTournamentMatchBinding(input.binding);
    const authority = decodeAuthority(input.authority);
    requireEpoch(input.startedAtEpochMs, 'Tournament match start');
    requireEpoch(input.finishedAtEpochMs, 'Tournament match finish');
    if (input.finishedAtEpochMs <= input.startedAtEpochMs) {
        throw new TypeError('Tournament finish must follow start');
    }
    if (!Array.isArray(input.scores) || input.scores.length !== 2 || !input.scores.every(Number.isSafeInteger)) {
        throw new TypeError('Tournament native scores must be two safe integers');
    }
    const standings = deriveRallarMatchStandings({
        rows: binding.principalIds.map((principalId, index) => ({
            participantId: principalId,
            principalId,
            sessionIds: [],
            metrics: { points: input.scores[index] }
        }))
    });
    return {
        ...createRallarServerValidatedMatchResult({
            resultId: tournamentResultKey(binding),
            matchId: binding.gameId,
            roomRef: binding.roomRef,
            protocol: binding.rulesId,
            authority,
            startedAtEpochMs: input.startedAtEpochMs,
            finishedAtEpochMs: input.finishedAtEpochMs,
            standings,
            summary: binding,
            idempotencyKey: tournamentResultKey(binding)
        }),
        startedAtEpochMs: input.startedAtEpochMs
    };
}

/** Validates storage integrity and binding; parsing alone never confers result authority. */
export function decodeTournamentResult(value: unknown, expected: TournamentMatchBinding): TournamentMatchResult {
    const result = requireRecord(value, 'Tournament result');
    requireExactKeys(result, [
        'resultId',
        'matchId',
        'roomRef',
        'protocol',
        'authority',
        'trust',
        'startedAtEpochMs',
        'finishedAtEpochMs',
        'standings',
        'summary',
        'idempotencyKey'
    ], 'Tournament result');
    const binding = decodeTournamentMatchBinding(result.summary);
    if (!jsonEquals(binding, decodeTournamentMatchBinding(expected))) {
        throw new TypeError('Tournament result binding differs');
    }
    requireEpoch(result.startedAtEpochMs, 'Tournament match start');
    requireEpoch(result.finishedAtEpochMs, 'Tournament match finish');
    const scores = decodeScores(result.standings, binding);
    const canonical = createTournamentResult({
        binding,
        authority: decodeAuthority(result.authority),
        startedAtEpochMs: result.startedAtEpochMs,
        finishedAtEpochMs: result.finishedAtEpochMs,
        scores
    });
    if (!jsonEquals(result, canonical)) {
        throw new TypeError('Tournament result fields or standings differ from its native scores');
    }
    return canonical;
}

export function tournamentResultKey(binding: TournamentMatchBinding): string {
    const ref = binding.tournamentRef;
    return `${groupStateScopeStorageKey(ref)}:tournament=${encodeURIComponent(ref.tournamentId)}` +
        `:slot=${encodeURIComponent(binding.slot)}:attempt=${encodeURIComponent(binding.attemptId)}`;
}

function decodeAuthority(value: unknown): RallarMatchServerAuthorityDescriptor {
    const authority = requireRecord(value, 'Tournament result authority');
    requireExactKeys(authority, ['kind', 'id', 'epoch'], 'Tournament result authority');
    requireString(authority.id, 'Tournament server identity');
    requireEpoch(authority.epoch, 'Tournament server epoch');
    if (authority.kind !== 'server') {
        throw new TypeError('Tournament results require server authority');
    }
    return { kind: 'server', id: authority.id, epoch: authority.epoch };
}

function decodeScores(value: unknown, binding: TournamentMatchBinding): readonly [number, number] {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError('Tournament standings require two accounts');
    }
    const rows = value.map((row) => requireRecord(row, 'Tournament standing'));
    const scores = binding.principalIds.map((principalId) => {
        const row = rows.find((standing) => standing.principalId === principalId);
        const metrics = requireRecord(row?.metrics, 'Tournament native metrics');
        requireExactKeys(metrics, ['points'], 'Tournament native metrics');
        if (typeof metrics.points !== 'number' || !Number.isSafeInteger(metrics.points)) {
            throw new TypeError('Tournament native score must be a safe integer');
        }
        return metrics.points;
    });
    return [scores[0], scores[1]];
}
