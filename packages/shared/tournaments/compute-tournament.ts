import { requireEpoch, requireString } from '../api/exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../api/rallar-validation.ts';
import { decodeTournamentMatchBinding } from '../api/tournaments/decode-tournament-match-binding.ts';
import type { TournamentCommand } from '../api/tournaments/tournament-request.ts';
import type {
    Tournament,
    TournamentMatch,
    TournamentMatchResult,
    TournamentRef,
    TournamentResolution
} from '../api/tournaments/tournament-types.ts';
import { jsonEquals } from '../repository/state-utils.ts';

export interface CreateTournamentInput {
    readonly ref: TournamentRef;
    readonly title: string;
    readonly organizerPrincipalId: string;
    readonly rulesId: string;
    readonly createdAtEpochMs: number;
    readonly noShowGraceMs: number;
}

export interface ComputeTournamentInput {
    readonly state: Tournament;
    readonly command: TournamentCommand;
    readonly actorPrincipalId: string | null;
    readonly nowEpochMs: number;
    /** Exact decoded results read from private authoritative storage, never from caller payloads. */
    readonly results: readonly TournamentMatchResult[];
}

export interface TournamentDecision {
    readonly state: Tournament;
    readonly refusal: string | null;
}

export function createTournament(input: CreateTournamentInput): Tournament {
    requireString(input.title, 'Tournament title');
    requireEpoch(input.createdAtEpochMs, 'Tournament creation');
    requireEpoch(input.noShowGraceMs, 'Tournament no-show grace');
    if (input.noShowGraceMs === 0 || input.title.trim() !== input.title || input.title.length > 120) {
        throw new TypeError('Tournament title or no-show grace is invalid');
    }
    for (const value of [...Object.values(input.ref), input.organizerPrincipalId, input.rulesId]) {
        assertValidRallarRouteId(value);
    }
    return { ...input, status: 'registration', entrants: [], matches: [], championPrincipalId: null };
}

/** Pure bracket policy. Persistence fences the complete predecessor, room admission and attempt authority together. */
export function computeTournament(input: ComputeTournamentInput): TournamentDecision {
    requireEpoch(input.nowEpochMs, 'Tournament decision clock');
    const state = settleTournament(input);
    const current = { ...input, state };
    const { command, actorPrincipalId } = input;
    if (command.type === 'reconcile') {
        return { state, refusal: null };
    }
    if (state.status === 'cancelled' || state.status === 'complete') {
        return { state, refusal: 'tournament-finished' };
    }
    if (actorPrincipalId === null) {
        return { state, refusal: 'authentication-required' };
    }
    if (command.type === 'register') {
        return registerEntrant(current, actorPrincipalId);
    }
    if (command.type === 'withdraw') {
        return withdrawEntrant(current, actorPrincipalId);
    }
    if (command.type === 'check-in') {
        return changeMatch(current, command);
    }
    if (actorPrincipalId !== state.organizerPrincipalId) {
        return { state, refusal: 'organizer-required' };
    }
    if (command.type === 'launch') {
        return launchTournament(state);
    }
    if (command.type === 'cancel') {
        return {
            state: {
                ...state,
                status: 'cancelled',
                matches: state.matches.map((match) =>
                    match.status === 'complete' ? match : { ...match, status: 'cancelled' }
                )
            },
            refusal: null
        };
    }
    if (command.type === 'schedule' || command.type === 'start') {
        return changeMatch(current, command);
    }
    return { state, refusal: 'unsupported-command' };
}

function registerEntrant(input: ComputeTournamentInput, principalId: string): TournamentDecision {
    const { state } = input;
    if (state.status !== 'registration') {
        return { state, refusal: 'registration-closed' };
    }
    if (state.entrants.some((entrant) => entrant.principalId === principalId)) {
        return { state, refusal: null };
    }
    if (state.entrants.length === 4) {
        return { state, refusal: 'tournament-full' };
    }
    assertValidRallarRouteId(principalId);
    return {
        state: {
            ...state,
            entrants: [...state.entrants, {
                principalId,
                registeredAtEpochMs: input.nowEpochMs,
                withdrawnAtEpochMs: null
            }]
        },
        refusal: null
    };
}

function withdrawEntrant(input: ComputeTournamentInput, principalId: string): TournamentDecision {
    const { state } = input;
    if (!state.entrants.some((entrant) => entrant.principalId === principalId)) {
        return { state, refusal: 'not-an-entrant' };
    }
    if (state.status === 'registration') {
        return {
            state: { ...state, entrants: state.entrants.filter((entrant) => entrant.principalId !== principalId) },
            refusal: null
        };
    }
    const entrants = state.entrants.map((entrant) =>
        entrant.principalId !== principalId || entrant.withdrawnAtEpochMs !== null
            ? entrant
            : { ...entrant, withdrawnAtEpochMs: input.nowEpochMs }
    );
    return { state: settleTournament({ ...input, state: { ...state, entrants } }), refusal: null };
}

function launchTournament(state: Tournament): TournamentDecision {
    if (state.status !== 'registration') {
        return { state, refusal: 'already-launched' };
    }
    if (state.entrants.length !== 4) {
        return { state, refusal: 'four-entrants-required' };
    }
    const ids = state.entrants.map((entrant) => entrant.principalId);
    const matches: TournamentMatch[] = [
        { slot: 'semifinal-1', principalIds: [ids[0], ids[1]], status: 'ready', attempt: null, resolution: null },
        { slot: 'semifinal-2', principalIds: [ids[2], ids[3]], status: 'ready', attempt: null, resolution: null },
        { slot: 'final', principalIds: null, status: 'waiting', attempt: null, resolution: null }
    ];
    return { state: { ...state, status: 'active', matches }, refusal: null };
}

function changeMatch(
    input: ComputeTournamentInput,
    command: Extract<TournamentCommand, { readonly slot: TournamentMatch['slot']; }>
): TournamentDecision {
    const { state } = input;
    const match = state.matches.find((candidate) => candidate.slot === command.slot);
    if (match === undefined || match.principalIds === null) {
        return { state, refusal: 'match-not-ready' };
    }
    if (match.status === 'complete' || match.status === 'cancelled') {
        return { state, refusal: 'match-resolved' };
    }
    if (command.type === 'schedule') {
        return scheduleMatch(input, match, command);
    }
    if (match.attempt?.binding.attemptId !== command.attemptId) {
        return { state, refusal: 'stale-attempt' };
    }
    const attempt = match.attempt;
    const withdrawn = state.entrants.filter((entrant) => entrant.withdrawnAtEpochMs !== null).map((entrant) =>
        entrant.principalId
    );
    if (command.type === 'check-in' && input.actorPrincipalId !== null && withdrawn.includes(input.actorPrincipalId)) {
        return { state, refusal: 'entrant-withdrawn' };
    }
    const waitingForForfeit = match.status === 'unresolved' &&
        match.principalIds.some((id) => withdrawn.includes(id)) &&
        input.nowEpochMs < attempt.scheduledAtEpochMs + state.noShowGraceMs;
    if (match.status !== 'scheduled' && !(command.type === 'check-in' && waitingForForfeit)) {
        return { state, refusal: 'match-not-scheduled' };
    }
    if (command.type === 'check-in') {
        if (input.actorPrincipalId === null || !match.principalIds.includes(input.actorPrincipalId)) {
            return { state, refusal: 'not-a-competitor' };
        }
        if (attempt.checkedInPrincipalIds.includes(input.actorPrincipalId)) {
            return { state, refusal: null };
        }
        return replaceMatch(state, {
            ...match,
            attempt: { ...attempt, checkedInPrincipalIds: [...attempt.checkedInPrincipalIds, input.actorPrincipalId] }
        });
    }
    if (attempt.checkedInPrincipalIds.length !== 2) {
        return { state, refusal: 'both-check-ins-required' };
    }
    if (input.nowEpochMs < attempt.scheduledAtEpochMs) {
        return { state, refusal: 'before-start' };
    }
    return replaceMatch(state, {
        ...match,
        status: 'playing',
        attempt: { ...attempt, startedAtEpochMs: input.nowEpochMs }
    });
}

function scheduleMatch(
    input: ComputeTournamentInput,
    match: TournamentMatch,
    command: Extract<TournamentCommand, { readonly type: 'schedule'; }>
): TournamentDecision {
    requireEpoch(command.scheduledAtEpochMs, 'Tournament schedule');
    requireEpoch(command.scheduledAtEpochMs + input.state.noShowGraceMs, 'Tournament deadline');
    if (command.scheduledAtEpochMs < input.nowEpochMs) {
        return { state: input.state, refusal: 'schedule-in-past' };
    }
    if (match.attempt?.binding.attemptId === command.attemptId) {
        return { state: input.state, refusal: 'fresh-attempt-required' };
    }
    const binding = decodeTournamentMatchBinding({
        tournamentRef: input.state.ref,
        slot: match.slot,
        attemptId: command.attemptId,
        roomRef: {
            applicationId: input.state.ref.applicationId,
            workspaceId: input.state.ref.workspaceId,
            groupId: command.roomId
        },
        gameId: command.gameId,
        rulesId: input.state.rulesId,
        principalIds: match.principalIds
    });
    return replaceMatch(input.state, {
        ...match,
        status: 'scheduled',
        resolution: null,
        attempt: {
            binding,
            scheduledAtEpochMs: command.scheduledAtEpochMs,
            startedAtEpochMs: null,
            checkedInPrincipalIds: []
        }
    });
}

function replaceMatch(state: Tournament, replacement: TournamentMatch): TournamentDecision {
    return {
        state: {
            ...state,
            matches: state.matches.map((match) => match.slot === replacement.slot ? replacement : match)
        },
        refusal: null
    };
}

function settleTournament(input: ComputeTournamentInput): Tournament {
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
