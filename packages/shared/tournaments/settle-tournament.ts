import type { Tournament, TournamentMatch, TournamentResolution } from '../api/tournaments/tournament-types.ts';
import { jsonEquals } from '../repository/state-utils.ts';
import type { ComputeTournamentInput } from './compute-tournament.ts';

/** Apply accepted results, withdrawal deadlines and no-shows before evaluating the next user action. */
export function settleTournament(input: ComputeTournamentInput): Tournament {
    if (input.state.status !== 'active') {
        return input.state;
    }
    const matches = input.state.matches.map((match) => settleMatch(input, match));
    const first = matches.find((match) => match.slot === 'semifinal-1')!;
    const second = matches.find((match) => match.slot === 'semifinal-2')!;
    const finalIndex = matches.findIndex((match) => match.slot === 'final');
    if (matches[finalIndex].principalIds === null && first.resolution !== null && second.resolution !== null) {
        matches[finalIndex] = settleMatch(input, {
            ...matches[finalIndex],
            status: 'ready',
            principalIds: [first.resolution.winnerPrincipalId, second.resolution.winnerPrincipalId]
        });
    }
    const champion = matches[finalIndex].resolution?.winnerPrincipalId ?? null;
    return {
        ...input.state,
        matches,
        status: champion === null ? 'active' : 'complete',
        championPrincipalId: champion
    };
}

function settleMatch(input: ComputeTournamentInput, match: TournamentMatch): TournamentMatch {
    if (match.principalIds === null || match.status === 'complete' || match.status === 'cancelled') {
        return match;
    }
    const remaining = match.principalIds.filter((principalId) =>
        input.state.entrants.some((entrant) =>
            entrant.principalId === principalId && entrant.withdrawnAtEpochMs === null
        )
    );
    if (remaining.length === 0) {
        return { ...match, status: 'unresolved', resolution: null };
    }
    if (remaining.length === 1) {
        const attempt = match.attempt;
        if (
            attempt !== null && input.nowEpochMs >= attempt.scheduledAtEpochMs + input.state.noShowGraceMs &&
            attempt.checkedInPrincipalIds.includes(remaining[0])
        ) {
            return resolveMatch(match, {
                winnerPrincipalId: remaining[0],
                reason: 'withdrawal',
                resolvedAtEpochMs: input.nowEpochMs,
                resultId: null
            });
        }
        return { ...match, status: 'unresolved', resolution: null };
    }
    const attempt = match.attempt;
    if (attempt === null) {
        return match;
    }
    if (match.status === 'scheduled' && input.nowEpochMs >= attempt.scheduledAtEpochMs + input.state.noShowGraceMs) {
        if (attempt.checkedInPrincipalIds.length === 0) {
            return { ...match, status: 'unresolved' };
        }
        if (attempt.checkedInPrincipalIds.length === 1) {
            return resolveMatch(match, {
                winnerPrincipalId: attempt.checkedInPrincipalIds[0],
                reason: 'no-show',
                resolvedAtEpochMs: input.nowEpochMs,
                resultId: null
            });
        }
    }
    return settleScoredMatch(input, match);
}

function settleScoredMatch(input: ComputeTournamentInput, match: TournamentMatch): TournamentMatch {
    const attempt = match.attempt;
    if (match.status !== 'playing' || attempt === null || match.principalIds === null) {
        return match;
    }
    const result = input.results.find((candidate) => jsonEquals(candidate.summary, attempt.binding));
    if (result === undefined) {
        return match;
    }
    if (result.startedAtEpochMs !== attempt.startedAtEpochMs || result.finishedAtEpochMs > input.nowEpochMs) {
        throw new TypeError('Tournament result clock differs from its attempt');
    }
    const scores = match.principalIds.map((principalId) =>
        result.standings.find((standing) => standing.principalId === principalId)?.metrics.points
    );
    if (scores.some((score) => typeof score !== 'number' || !Number.isSafeInteger(score))) {
        throw new TypeError('Tournament result lacks native scores');
    }
    if (scores[0] === scores[1]) {
        return { ...match, status: 'tied' };
    }
    const winner = scores[0]! > scores[1]! ? match.principalIds[0] : match.principalIds[1];
    return resolveMatch(match, {
        winnerPrincipalId: winner,
        reason: 'score',
        resolvedAtEpochMs: result.finishedAtEpochMs,
        resultId: result.resultId
    });
}

function resolveMatch(match: TournamentMatch, resolution: TournamentResolution): TournamentMatch {
    return { ...match, status: 'complete', resolution };
}
