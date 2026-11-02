import { requireEpoch } from '@shared/api/exact-object-decoding.ts';
import { decodeMatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';

import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { computeMatchmakingCohorts } from './compute-matchmaking-cohorts.ts';
import { decodeMatchmakingPool } from './decode-matchmaking-pool.ts';
import { decodeMatchmakingPartySearches, type MatchmakingPartySearch } from './matchmaking-party-search.ts';
import type {
    MatchmakingActor,
    MatchmakingFinished,
    MatchmakingInput,
    MatchmakingIntent,
    MatchmakingInvalidationInput,
    MatchmakingPool,
    MatchmakingProposal,
    MatchmakingSearch,
    MatchmakingTransition
} from './matchmaking-pool.ts';

interface ConfirmSearchInput {
    readonly previous: MatchmakingTransition;
    readonly current: MatchmakingSearch;
    readonly actor: MatchmakingActor;
    readonly now: number;
}

/** Computes intent only. Admission and the resulting terminal tickets must commit in the same transaction. */
export function computeMatchmaking(input: MatchmakingInput): MatchmakingTransition {
    decodeMatchmakingPolicy(input.policy);
    requireEpoch(input.nowEpochMs, 'Matchmaking attempt time');
    const pool = decodeMatchmakingPool(input.pool, input.pool.scope);
    const partySearches = decodeMatchmakingPartySearches(input.partySearches, pool);
    const expired = retainActiveParties(expireSearches(pool, partySearches, input.nowEpochMs));
    const transition = computeCommand(input, expired);
    return retainActiveParties(transition);
}

/** Membership changes cancel reservations without applying search-formation policy. */
export function computeMatchmakingInvalidation(input: MatchmakingInvalidationInput): MatchmakingTransition {
    requireEpoch(input.nowEpochMs, 'Matchmaking invalidation time');
    const pool = decodeMatchmakingPool(input.pool, input.pool.scope);
    const parties = decodeMatchmakingPartySearches(input.partySearches, pool);
    const expired = retainActiveParties(expireSearches(pool, parties, input.nowEpochMs));
    return retainActiveParties(invalidateSearches(expired, input.principalIds, input.nowEpochMs));
}

function retainActiveParties(transition: MatchmakingTransition): MatchmakingTransition {
    const activeIds = new Set(
        [...transition.pool.searching, ...transition.pool.proposals.flatMap((proposal) => proposal.participants)]
            .map((search) => search.searchId)
    );
    return {
        ...transition,
        partySearches: transition.partySearches.filter((party) => party.searchIds.some((id) => activeIds.has(id)))
    };
}

function computeCommand(input: MatchmakingInput, expired: MatchmakingTransition): MatchmakingTransition {
    const command = input.command;
    if (command.action === 'expire') {
        return expired;
    }
    if (command.action === 'start-party') {
        return startSearch(input, expired, command);
    }
    if (
        expired.finished.some((search) =>
            search.principalId === command.principalId && search.searchId === command.searchId
        )
    ) {
        return { ...expired, searchId: command.searchId };
    }
    const current = findSearch(expired.pool, command.principalId);
    if (command.action === 'start') {
        return current === null
            ? startSearch(input, expired, command)
            : { ...expired, searchId: current.searchId };
    }
    if (current === null || current.searchId !== command.searchId) {
        return { ...expired, searchId: command.searchId, rejection: 'search-not-current' };
    }
    return command.action === 'cancel'
        ? cancelSearch(expired, current, input.nowEpochMs)
        : confirmSearch({ previous: expired, current, actor: command, now: input.nowEpochMs });
}

function expireSearches(
    pool: MatchmakingPool,
    partySearches: readonly MatchmakingPartySearch[],
    now: number
): MatchmakingTransition {
    const searching: MatchmakingSearch[] = [];
    const proposals: MatchmakingProposal[] = [];
    const finished: MatchmakingFinished[] = [];
    for (const search of pool.searching) {
        if (search.expiresAtEpochMs <= now) {
            finished.push(finishSearch(search, 'search-timeout', now));
        }
        else {
            searching.push(search);
        }
    }
    for (const proposal of pool.proposals) {
        if (proposal.expiresAtEpochMs <= now) {
            finished.push(...proposal.participants.map((player) => finishSearch(player, 'confirmation-timeout', now)));
        }
        else {
            proposals.push(proposal);
        }
    }
    return {
        pool: { ...pool, searching, proposals },
        partySearches,
        finished,
        admission: null,
        searchId: null,
        rejection: null
    };
}

function startSearch(
    input: MatchmakingInput,
    previous: MatchmakingTransition,
    command:
        | Extract<MatchmakingIntent, { action: 'start-party'; }>
        | Exclude<MatchmakingIntent, { action: 'expire' | 'start-party'; }>
): MatchmakingTransition {
    const { pool } = previous;
    const party = command.action === 'start-party' ? command.party : null;
    const actors = party === null ? [command] : party.members;
    if (
        actors.length === 0 || actors.length > input.policy.players ||
        new Set(actors.map((actor) => actor.principalId)).size !== actors.length ||
        actors.some((actor) => findSearch(pool, actor.principalId) !== null) ||
        (party !== null &&
            (party.leaderPrincipalId !== command.principalId ||
                !actors.some((actor) => actor.principalId === command.principalId)))
    ) {
        return { ...previous, searchId: command.searchId, rejection: 'search-not-current' };
    }
    const count = pool.searching.length +
        pool.proposals.reduce((total, proposal) => total + proposal.participants.length, 0);
    if (count + actors.length > input.policy.maxSearching) {
        return { ...previous, searchId: command.searchId, rejection: 'search-capacity' };
    }
    requireEpoch(command.capturedAtEpochMs, 'Captured search time');
    const additions: MatchmakingSearch[] = actors.toSorted((left, right) =>
        Number(right.principalId === command.principalId) - Number(left.principalId === command.principalId) ||
        (left.principalId < right.principalId ? -1 : left.principalId > right.principalId ? 1 : 0)
    ).map((actor) => ({
        principalId: actor.principalId,
        sessionId: actor.sessionId,
        sessionIssuedAtEpochMs: actor.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: actor.sessionExpiresAtEpochMs,
        searchId: actor.principalId === command.principalId ? command.searchId : computeSha256CanonicalJson({
            partyRef: party!.ref,
            searchId: command.searchId,
            principalId: actor.principalId
        }),
        createdAtEpochMs: command.capturedAtEpochMs,
        expiresAtEpochMs: command.capturedAtEpochMs + input.policy.searchTimeoutMs
    }));
    if (
        additions.some((search) =>
            pool.searching.some((current) => current.searchId === search.searchId) ||
            findProposal(pool, search.searchId) !== null
        )
    ) {
        return { ...previous, searchId: command.searchId, rejection: 'search-not-current' };
    }
    if (additions[0]!.expiresAtEpochMs <= input.nowEpochMs) {
        return {
            ...previous,
            searchId: command.searchId,
            finished: [
                ...previous.finished,
                ...additions.map((search) => finishSearch(search, 'search-timeout', input.nowEpochMs))
            ]
        };
    }
    const partySearches = party === null ? previous.partySearches : [...previous.partySearches, {
        ref: party.ref,
        rosterRevision: party.rosterRevision,
        leaderPrincipalId: party.leaderPrincipalId,
        searchIds: additions.map((search) => search.searchId)
    }];
    const queued = [...pool.searching, ...additions];
    decodeMatchmakingPartySearches(partySearches, { ...pool, searching: queued });
    const formed = computeMatchmakingCohorts({
        scope: input.pool.scope,
        policy: input.policy,
        nowEpochMs: input.nowEpochMs,
        queued,
        partySearches
    });
    return {
        ...previous,
        searchId: command.searchId,
        partySearches,
        pool: { ...pool, searching: formed.searching, proposals: [...pool.proposals, ...formed.proposals] }
    };
}

function invalidateSearches(
    previous: MatchmakingTransition,
    principalIds: readonly string[],
    now: number
): MatchmakingTransition {
    let result = previous;
    for (const principalId of principalIds) {
        const current = findSearch(result.pool, principalId);
        if (current !== null) {
            result = cancelSearch(result, current, now);
        }
    }
    return { ...result, searchId: null };
}

function cancelSearch(previous: MatchmakingTransition, current: MatchmakingSearch, now: number): MatchmakingTransition {
    const proposal = findProposal(previous.pool, current.searchId);
    const party = previous.partySearches.find((party) => party.searchIds.includes(current.searchId));
    const cancelledIds = new Set(party?.searchIds ?? [current.searchId]);
    const finished = proposal === null
        ? previous.pool.searching.filter((search) => cancelledIds.has(search.searchId)).map((search) =>
            finishSearch(search, 'cancelled', now)
        )
        : proposal.participants.map((player) => finishSearch(player, 'declined', now));
    return {
        ...previous,
        searchId: current.searchId,
        pool: {
            ...previous.pool,
            searching: previous.pool.searching.filter((search) => !cancelledIds.has(search.searchId)),
            proposals: previous.pool.proposals.filter((candidate) => candidate !== proposal)
        },
        finished: [...previous.finished, ...finished]
    };
}

function confirmSearch(input: ConfirmSearchInput): MatchmakingTransition {
    const { previous, current, actor, now } = input;
    const proposal = findProposal(previous.pool, current.searchId);
    if (proposal === null) {
        return { ...previous, searchId: current.searchId, rejection: 'search-not-current' };
    }
    const confirmed: MatchmakingProposal = {
        ...proposal,
        participants: proposal.participants.map((player) =>
            player.searchId === current.searchId
                ? {
                    ...player,
                    sessionId: actor.sessionId,
                    sessionIssuedAtEpochMs: actor.sessionIssuedAtEpochMs,
                    sessionExpiresAtEpochMs: actor.sessionExpiresAtEpochMs,
                    confirmedAtEpochMs: player.confirmedAtEpochMs ?? now
                }
                : player
        )
    };
    const ready = confirmed.participants.every((player) => player.confirmedAtEpochMs !== null);
    return {
        ...previous,
        searchId: current.searchId,
        pool: {
            ...previous.pool,
            proposals: previous.pool.proposals.flatMap((candidate) =>
                candidate !== proposal ? [candidate] : ready ? [] : [confirmed]
            )
        },
        admission: ready ? confirmed : null,
        finished: ready
            ? [
                ...previous.finished,
                ...confirmed.participants.map((player) => ({
                    ...finishSearch(player, 'matched', now),
                    roomRef: confirmed.roomRef,
                    leaderPrincipalId: confirmed.leaderPrincipalId
                }))
            ]
            : previous.finished
    };
}

function findSearch(pool: MatchmakingPool, principalId: string): MatchmakingSearch | null {
    return pool.searching.find((search) => search.principalId === principalId) ??
        pool.proposals.flatMap((proposal) => proposal.participants).find((search) =>
            search.principalId === principalId
        ) ?? null;
}

function findProposal(pool: MatchmakingPool, searchId: string): MatchmakingProposal | null {
    return pool.proposals.find((proposal) => proposal.participants.some((player) => player.searchId === searchId)) ??
        null;
}

function finishSearch(
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
