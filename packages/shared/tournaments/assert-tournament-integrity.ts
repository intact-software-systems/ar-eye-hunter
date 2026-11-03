import { requireEpoch } from '../api/exact-object-decoding.ts';
import type { Tournament, TournamentMatch, TournamentResolution } from '../api/tournaments/tournament-types.ts';
import { jsonEquals } from '../repository/state-utils.ts';

/** Cross-field bracket invariants shared by canonical reads and prepared writes. */
export function assertTournamentIntegrity(state: Tournament): void {
    if (
        new Set(state.entrants.map((entrant) => entrant.principalId)).size !== state.entrants.length ||
        state.entrants.some((entrant) => entrant.registeredAtEpochMs < state.createdAtEpochMs)
    ) {
        throw new TypeError('Tournament entrants are duplicated or predate creation');
    }
    if (state.status === 'registration' || state.status === 'cancelled' && state.matches.length === 0) {
        if (
            state.matches.length !== 0 || state.championPrincipalId !== null ||
            state.entrants.some((entrant) => entrant.withdrawnAtEpochMs !== null)
        ) {
            throw new TypeError('Unlaunched tournament has a bracket or withdrawn registration');
        }
        return;
    }
    if (
        state.entrants.length !== 4 || state.matches.length !== 3 ||
        !jsonEquals(state.matches.map((match) => match.slot), ['semifinal-1', 'semifinal-2', 'final'])
    ) {
        throw new TypeError('Launched tournament requires four seeds and its three ordered slots');
    }
    const [first, second, final] = state.matches;
    if (
        !jsonEquals(first.principalIds, state.entrants.slice(0, 2).map((entrant) => entrant.principalId)) ||
        !jsonEquals(second.principalIds, state.entrants.slice(2).map((entrant) => entrant.principalId))
    ) {
        throw new TypeError('Tournament semifinal seeds differ from registration order');
    }
    const finalists = first.resolution !== null && second.resolution !== null
        ? [first.resolution.winnerPrincipalId, second.resolution.winnerPrincipalId]
        : null;
    if (!jsonEquals(final.principalIds, finalists)) {
        throw new TypeError('Tournament final differs from semifinal winners');
    }
    for (const match of state.matches) {
        assertMatchIntegrity(state, match);
    }
    const champion = final.resolution?.winnerPrincipalId ?? null;
    if (champion !== state.championPrincipalId || (state.status === 'complete') !== (champion !== null)) {
        throw new TypeError('Tournament champion must be the resolved final winner');
    }
    if (
        state.status === 'cancelled' &&
        state.matches.some((match) => match.status !== 'complete' && match.status !== 'cancelled')
    ) {
        throw new TypeError('Cancelled tournament contains a playable match');
    }
}

function assertMatchIntegrity(state: Tournament, match: TournamentMatch): void {
    const { attempt, resolution } = match;
    if (
        (match.status === 'complete') !== (resolution !== null) ||
        match.principalIds === null && (match.attempt !== null || !['waiting', 'cancelled'].includes(match.status))
    ) {
        throw new TypeError('Tournament match status differs from its participants or resolution');
    }
    if (attempt === null) {
        if (!['waiting', 'ready', 'unresolved', 'cancelled'].includes(match.status)) {
            throw new TypeError('Tournament match lacks its attempt');
        }
        return;
    }
    if (
        !jsonEquals(attempt.binding.tournamentRef, state.ref) || attempt.binding.rulesId !== state.rulesId ||
        attempt.binding.slot !== match.slot || !jsonEquals(attempt.binding.principalIds, match.principalIds)
    ) {
        throw new TypeError('Tournament attempt binding differs from its bracket');
    }
    requireEpoch(attempt.scheduledAtEpochMs + state.noShowGraceMs, 'Tournament no-show deadline');
    if (
        ['waiting', 'ready'].includes(match.status) ||
        match.status === 'scheduled' && attempt.startedAtEpochMs !== null ||
        ['playing', 'tied'].includes(match.status) && attempt.startedAtEpochMs === null
    ) {
        throw new TypeError('Tournament attempt phase differs from its match');
    }
    if (resolution !== null) {
        assertResolutionIntegrity(state, match, resolution);
    }
}

function assertResolutionIntegrity(state: Tournament, match: TournamentMatch, resolution: TournamentResolution): void {
    const attempt = match.attempt!;
    if (!match.principalIds?.includes(resolution.winnerPrincipalId)) {
        throw new TypeError('Tournament winner is not a competitor');
    }
    if (resolution.reason === 'score') {
        if (attempt.startedAtEpochMs === null || resolution.resolvedAtEpochMs <= attempt.startedAtEpochMs) {
            throw new TypeError('Tournament scored result precedes gameplay');
        }
        return;
    }
    if (
        resolution.resolvedAtEpochMs < attempt.scheduledAtEpochMs + state.noShowGraceMs ||
        !attempt.checkedInPrincipalIds.includes(resolution.winnerPrincipalId)
    ) {
        throw new TypeError('Tournament forfeit requires check-in and the grace deadline');
    }
    if (resolution.reason === 'no-show' && attempt.checkedInPrincipalIds.length !== 1) {
        throw new TypeError('No-show requires one check-in');
    }
    if (
        resolution.reason === 'withdrawal' &&
        !state.entrants.some((entrant) =>
            entrant.principalId !== resolution.winnerPrincipalId && match.principalIds?.includes(entrant.principalId) &&
            entrant.withdrawnAtEpochMs !== null
        )
    ) {
        throw new TypeError('Tournament withdrawal result lacks a withdrawn opponent');
    }
}
