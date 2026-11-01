import { requireEpoch } from '@shared/api/exact-object-decoding.ts';
import { decodeMatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';

import { decodeMatchmakingPool } from './decode-matchmaking-pool.ts';
import type {
    MatchmakingActor,
    MatchmakingFinished,
    MatchmakingInput,
    MatchmakingIntent,
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
    const expired = expireSearches(pool, input.nowEpochMs);
    const command = input.command;
    if (command.action === 'expire') {
        return expired;
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

function expireSearches(pool: MatchmakingPool, now: number): MatchmakingTransition {
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
        finished,
        admission: null,
        searchId: null,
        rejection: null
    };
}

function startSearch(
    input: MatchmakingInput,
    previous: MatchmakingTransition,
    command: Exclude<MatchmakingIntent, { action: 'expire'; }>
): MatchmakingTransition {
    const { pool } = previous;
    if (
        pool.searching.some((search) => search.searchId === command.searchId) ||
        findProposal(pool, command.searchId) !== null
    ) {
        return { ...previous, searchId: command.searchId, rejection: 'search-not-current' };
    }
    const count = pool.searching.length +
        pool.proposals.reduce((total, proposal) => total + proposal.participants.length, 0);
    if (count >= input.policy.maxSearching) {
        return { ...previous, searchId: command.searchId, rejection: 'search-capacity' };
    }
    requireEpoch(command.capturedAtEpochMs, 'Captured search time');
    const search: MatchmakingSearch = {
        searchId: command.searchId,
        principalId: command.principalId,
        sessionId: command.sessionId,
        sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs,
        createdAtEpochMs: command.capturedAtEpochMs,
        expiresAtEpochMs: command.capturedAtEpochMs + input.policy.searchTimeoutMs
    };
    if (search.expiresAtEpochMs <= input.nowEpochMs) {
        return {
            ...previous,
            searchId: search.searchId,
            finished: [...previous.finished, finishSearch(search, 'search-timeout', input.nowEpochMs)]
        };
    }
    const queued = [...pool.searching, search].sort((left, right) =>
        left.createdAtEpochMs - right.createdAtEpochMs ||
        (left.searchId < right.searchId ? -1 : left.searchId > right.searchId ? 1 : 0)
    );
    const formed = formCohorts(input, queued);
    return {
        ...previous,
        searchId: search.searchId,
        pool: { ...pool, searching: formed.searching, proposals: [...pool.proposals, ...formed.proposals] }
    };
}

function formCohorts(
    input: MatchmakingInput,
    queued: readonly MatchmakingSearch[]
): Pick<MatchmakingPool, 'searching' | 'proposals'> {
    const searching = [...queued];
    const proposals: MatchmakingProposal[] = [];
    while (searching.length >= input.policy.players) {
        const cohort = searching.splice(0, input.policy.players);
        const leader = cohort[0]!;
        proposals.push({
            roomRef: { ...input.pool.scope, groupId: `match-${leader.searchId}` },
            leaderPrincipalId: leader.principalId,
            createdAtEpochMs: input.nowEpochMs,
            expiresAtEpochMs: input.nowEpochMs + input.policy.confirmationTimeoutMs,
            participants: cohort.map((search) => ({ ...search, confirmedAtEpochMs: null }))
        });
    }
    return { searching, proposals };
}

function cancelSearch(previous: MatchmakingTransition, current: MatchmakingSearch, now: number): MatchmakingTransition {
    const proposal = findProposal(previous.pool, current.searchId);
    const finished = proposal === null
        ? [finishSearch(current, 'cancelled', now)]
        : proposal.participants.map((player) => finishSearch(player, 'declined', now));
    return {
        ...previous,
        searchId: current.searchId,
        pool: {
            ...previous.pool,
            searching: previous.pool.searching.filter((search) => search.searchId !== current.searchId),
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
