import { assertTournamentIntegrity } from '../../tournaments/assert-tournament-integrity.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeTournamentMatchBinding, decodeTournamentRef } from './decode-tournament-match-binding.ts';
import type {
    Tournament,
    TournamentAttempt,
    TournamentEntrant,
    TournamentMatch,
    TournamentResolution
} from './tournament-types.ts';

/** Exact public/storage representation. A decoded result reference does not confer game result authority. */
export function decodeTournament(value: unknown): Tournament {
    const record = requireRecord(value, 'Tournament');
    requireExactKeys(record, [
        'ref',
        'title',
        'organizerPrincipalId',
        'rulesId',
        'createdAtEpochMs',
        'noShowGraceMs',
        'status',
        'entrants',
        'matches',
        'championPrincipalId'
    ], 'Tournament');
    requireEpoch(record.createdAtEpochMs, 'Tournament creation');
    requireEpoch(record.noShowGraceMs, 'Tournament no-show grace');
    if (record.noShowGraceMs === 0) {
        throw new TypeError('Tournament grace must be positive');
    }
    if (!Array.isArray(record.entrants) || record.entrants.length > 4 || !Array.isArray(record.matches)) {
        throw new TypeError('Tournament roster or bracket is invalid');
    }
    const state: Tournament = {
        ref: decodeTournamentRef(record.ref),
        title: decodeTournamentTitle(record.title),
        organizerPrincipalId: assertValidRallarRouteId(record.organizerPrincipalId),
        rulesId: assertValidRallarRouteId(record.rulesId),
        createdAtEpochMs: record.createdAtEpochMs,
        noShowGraceMs: record.noShowGraceMs,
        status: requireOneOf(record.status, ['registration', 'active', 'complete', 'cancelled'], 'Tournament status'),
        entrants: record.entrants.map(decodeEntrant),
        matches: record.matches.map(decodeMatch),
        championPrincipalId: record.championPrincipalId === null
            ? null
            : assertValidRallarRouteId(record.championPrincipalId)
    };
    assertTournamentIntegrity(state);
    return state;
}

export function decodeTournamentTitle(value: unknown): string {
    requireString(value, 'Tournament title');
    if (value.trim() !== value || value.length > 120) {
        throw new TypeError('Tournament title is invalid');
    }
    return value;
}

function decodeEntrant(value: unknown): TournamentEntrant {
    const entrant = requireRecord(value, 'Tournament entrant');
    requireExactKeys(entrant, ['principalId', 'registeredAtEpochMs', 'withdrawnAtEpochMs'], 'Tournament entrant');
    requireEpoch(entrant.registeredAtEpochMs, 'Tournament registration');
    if (entrant.withdrawnAtEpochMs !== null) {
        requireEpoch(entrant.withdrawnAtEpochMs, 'Tournament withdrawal');
    }
    if (entrant.withdrawnAtEpochMs !== null && entrant.withdrawnAtEpochMs < entrant.registeredAtEpochMs) {
        throw new TypeError('Tournament withdrawal precedes registration');
    }
    return {
        principalId: assertValidRallarRouteId(entrant.principalId),
        registeredAtEpochMs: entrant.registeredAtEpochMs,
        withdrawnAtEpochMs: entrant.withdrawnAtEpochMs
    };
}

function decodeMatch(value: unknown): TournamentMatch {
    const match = requireRecord(value, 'Tournament match');
    requireExactKeys(match, ['slot', 'principalIds', 'status', 'attempt', 'resolution'], 'Tournament match');
    let principals: readonly [string, string] | null = null;
    if (match.principalIds !== null) {
        if (
            !Array.isArray(match.principalIds) || match.principalIds.length !== 2 ||
            match.principalIds[0] === match.principalIds[1]
        ) {
            throw new TypeError('Tournament match requires two distinct accounts');
        }
        principals = [assertValidRallarRouteId(match.principalIds[0]), assertValidRallarRouteId(match.principalIds[1])];
    }
    return {
        slot: requireOneOf(match.slot, ['semifinal-1', 'semifinal-2', 'final'], 'Tournament slot'),
        principalIds: principals,
        status: requireOneOf(match.status, [
            'waiting',
            'ready',
            'scheduled',
            'playing',
            'tied',
            'unresolved',
            'complete',
            'cancelled'
        ], 'Tournament match status'),
        attempt: match.attempt === null ? null : decodeAttempt(match.attempt),
        resolution: match.resolution === null ? null : decodeResolution(match.resolution)
    };
}

function decodeAttempt(value: unknown): TournamentAttempt {
    const attempt = requireRecord(value, 'Tournament attempt');
    requireExactKeys(
        attempt,
        ['binding', 'scheduledAtEpochMs', 'startedAtEpochMs', 'checkedInPrincipalIds'],
        'Tournament attempt'
    );
    requireEpoch(attempt.scheduledAtEpochMs, 'Tournament schedule');
    if (attempt.startedAtEpochMs !== null) {
        requireEpoch(attempt.startedAtEpochMs, 'Tournament start');
    }
    const binding = decodeTournamentMatchBinding(attempt.binding);
    const ids = attempt.checkedInPrincipalIds;
    if (
        !Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length ||
        ids.some((id) => !binding.principalIds.includes(id))
    ) {
        throw new TypeError('Tournament check-ins must name distinct bound competitors');
    }
    if (
        attempt.startedAtEpochMs !== null && (attempt.startedAtEpochMs < attempt.scheduledAtEpochMs || ids.length !== 2)
    ) {
        throw new TypeError('Tournament start requires both check-ins at or after the schedule');
    }
    return {
        binding,
        scheduledAtEpochMs: attempt.scheduledAtEpochMs,
        startedAtEpochMs: attempt.startedAtEpochMs,
        checkedInPrincipalIds: ids
    };
}

function decodeResolution(value: unknown): TournamentResolution {
    const resolution = requireRecord(value, 'Tournament resolution');
    requireExactKeys(
        resolution,
        ['reason', 'winnerPrincipalId', 'resolvedAtEpochMs', 'resultId'],
        'Tournament resolution'
    );
    const reason = requireOneOf(resolution.reason, ['score', 'withdrawal', 'no-show'], 'Tournament resolution reason');
    requireEpoch(resolution.resolvedAtEpochMs, 'Tournament resolution time');
    if (resolution.resultId !== null) {
        requireString(resolution.resultId, 'Tournament result identity');
    }
    if ((reason === 'score') !== (resolution.resultId !== null)) {
        throw new TypeError('Only a scored match names a game result');
    }
    return {
        reason,
        winnerPrincipalId: assertValidRallarRouteId(resolution.winnerPrincipalId),
        resolvedAtEpochMs: resolution.resolvedAtEpochMs,
        resultId: resolution.resultId
    };
}
