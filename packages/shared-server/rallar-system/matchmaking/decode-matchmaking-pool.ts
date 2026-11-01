import {
    requireEpoch,
    requireExactKeys,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type {
    MatchmakingParticipant,
    MatchmakingPool,
    MatchmakingProposal,
    MatchmakingSearch
} from './matchmaking-pool.ts';

const SEARCH_FIELDS = ['searchId', 'principalId', 'sessionId', 'createdAtEpochMs', 'expiresAtEpochMs'];

export function decodeMatchmakingPool(value: unknown, expectedScope: StateScope): MatchmakingPool {
    const pool = requireRecord(value, 'Matchmaking pool');
    requireExactKeys(pool, ['scope', 'searching', 'proposals'], 'Matchmaking pool');
    const scope = requireRecord(pool.scope, 'Matchmaking scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'Matchmaking scope');
    requireString(scope.applicationId, 'Matchmaking application');
    requireString(scope.workspaceId, 'Matchmaking workspace');
    if (scope.applicationId !== expectedScope.applicationId || scope.workspaceId !== expectedScope.workspaceId) {
        throw new TypeError('Matchmaking pool scope differs from its storage identity');
    }
    if (!Array.isArray(pool.searching) || !Array.isArray(pool.proposals)) {
        throw new TypeError('Matchmaking pool requires searching and proposal arrays');
    }
    const searching = pool.searching.map(decodeSearch);
    const proposals = pool.proposals.map(decodeProposal);
    if (
        proposals.some((proposal) =>
            proposal.roomRef.applicationId !== expectedScope.applicationId ||
            proposal.roomRef.workspaceId !== expectedScope.workspaceId
        )
    ) {
        throw new TypeError('Matchmaking destination scope differs from its pool');
    }
    const all = [...searching, ...proposals.flatMap((proposal) => proposal.participants)];
    if (
        all.length > 1024 || new Set(all.map((search) => search.principalId)).size !== all.length ||
        new Set(all.map((search) => search.searchId)).size !== all.length
    ) {
        throw new TypeError('Matchmaking pool contains duplicate identities or exceeds its bound');
    }
    return { scope: { applicationId: scope.applicationId, workspaceId: scope.workspaceId }, searching, proposals };
}

function decodeSearch(value: unknown): MatchmakingSearch {
    const search = requireRecord(value, 'Matchmaking search');
    requireExactKeys(search, SEARCH_FIELDS, 'Matchmaking search');
    requireString(search.searchId, 'Search identity');
    requireString(search.principalId, 'Searching account');
    requireString(search.sessionId, 'Searching session');
    requireEpoch(search.createdAtEpochMs, 'Search creation time');
    requireEpoch(search.expiresAtEpochMs, 'Search deadline');
    if (search.searchId.length > 96 || search.expiresAtEpochMs <= search.createdAtEpochMs) {
        throw new TypeError('Matchmaking search identity or lifetime is invalid');
    }
    return {
        searchId: search.searchId,
        principalId: search.principalId,
        sessionId: search.sessionId,
        createdAtEpochMs: search.createdAtEpochMs,
        expiresAtEpochMs: search.expiresAtEpochMs
    };
}

function decodeParticipant(value: unknown): MatchmakingParticipant {
    const participant = requireRecord(value, 'Matchmaking participant');
    requireExactKeys(participant, [...SEARCH_FIELDS, 'confirmedAtEpochMs'], 'Matchmaking participant');
    if (participant.confirmedAtEpochMs !== null) {
        requireEpoch(participant.confirmedAtEpochMs, 'Confirmation time');
    }
    const { confirmedAtEpochMs, ...search } = participant;
    return { ...decodeSearch(search), confirmedAtEpochMs };
}

function decodeProposal(value: unknown): MatchmakingProposal {
    const proposal = requireRecord(value, 'Matchmaking proposal');
    requireExactKeys(proposal, [
        'roomRef',
        'leaderPrincipalId',
        'createdAtEpochMs',
        'expiresAtEpochMs',
        'participants'
    ], 'Matchmaking proposal');
    const room = requireRecord(proposal.roomRef, 'Matchmaking destination');
    requireExactKeys(room, ['applicationId', 'workspaceId', 'groupId'], 'Matchmaking destination');
    requireString(room.groupId, 'Matchmaking destination group');
    requireString(room.applicationId, 'Matchmaking application');
    requireString(room.workspaceId, 'Matchmaking workspace');
    requireString(proposal.leaderPrincipalId, 'Matchmaking leader');
    requireEpoch(proposal.createdAtEpochMs, 'Proposal creation time');
    requireEpoch(proposal.expiresAtEpochMs, 'Proposal deadline');
    const { createdAtEpochMs, expiresAtEpochMs } = proposal;
    if (
        !Array.isArray(proposal.participants) || proposal.participants.length < 2 || proposal.participants.length > 16
    ) {
        throw new TypeError('Matchmaking proposal requires between two and sixteen participants');
    }
    const participants = proposal.participants.map(decodeParticipant);
    const decoded: MatchmakingProposal = {
        roomRef: { applicationId: room.applicationId, workspaceId: room.workspaceId, groupId: room.groupId },
        leaderPrincipalId: proposal.leaderPrincipalId,
        createdAtEpochMs,
        expiresAtEpochMs,
        participants
    };
    validateProposalCohort(decoded);
    return decoded;
}

function validateProposalCohort(proposal: MatchmakingProposal): void {
    const { participants, createdAtEpochMs, expiresAtEpochMs } = proposal;
    const first = participants[0]!;
    if (
        expiresAtEpochMs <= createdAtEpochMs ||
        first.principalId !== proposal.leaderPrincipalId || proposal.roomRef.groupId !== `match-${first.searchId}` ||
        participants.some((player) =>
            player.createdAtEpochMs > createdAtEpochMs || player.expiresAtEpochMs <= createdAtEpochMs
        )
    ) {
        throw new TypeError('Matchmaking proposal identity or lifetime differs from its cohort');
    }
    if (
        participants.some((player) =>
            player.confirmedAtEpochMs !== null &&
            (player.confirmedAtEpochMs < createdAtEpochMs ||
                player.confirmedAtEpochMs >= expiresAtEpochMs)
        )
    ) {
        throw new TypeError('Matchmaking confirmation is outside its proposal window');
    }
}
