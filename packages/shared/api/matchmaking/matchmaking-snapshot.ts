import { isSameGroupScope } from '../api-type-utils.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { assertValidRallarGroupRef, assertValidRallarRouteId } from '../rallar-validation.ts';
import type { StateScope } from '../state-types.ts';
import { decodeMatchmakingScope } from './matchmaking-request.ts';

export type MatchmakingEndedReason =
    | 'search-timeout'
    | 'confirmation-timeout'
    | 'cancelled'
    | 'declined'
    | 'admission-denied';

export interface MatchmakingPlayer {
    readonly principalId: string;
    readonly confirmed: boolean;
}

export type MatchmakingState =
    | Readonly<{ status: 'idle'; }>
    | Readonly<{ status: 'searching'; searchId: string; expiresAtEpochMs: number; }>
    | Readonly<{
        status: 'confirming';
        searchId: string;
        expiresAtEpochMs: number;
        leaderPrincipalId: string;
        players: readonly MatchmakingPlayer[];
    }>
    | Readonly<{ status: 'matched'; searchId: string; roomRef: GroupRef; leaderPrincipalId: string; }>
    | Readonly<{ status: 'ended'; searchId: string; reason: MatchmakingEndedReason; }>;

export interface MatchmakingSnapshot {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly observedAtEpochMs: number;
    readonly state: MatchmakingState;
}

export function decodeMatchmakingSnapshot(value: unknown): MatchmakingSnapshot {
    const snapshot = requireRecord(value, 'Matchmaking snapshot');
    requireExactKeys(snapshot, ['scope', 'principalId', 'observedAtEpochMs', 'state'], 'Matchmaking snapshot');
    const scope = decodeMatchmakingScope(snapshot.scope);
    requireString(snapshot.principalId, 'Matchmaking account');
    requireEpoch(snapshot.observedAtEpochMs, 'Matchmaking observation time');
    const state = decodeState(snapshot.state);
    if (state.status === 'matched' && !isSameGroupScope(state.roomRef, scope)) {
        throw new TypeError('Matched destination differs from the requested scope');
    }
    if (state.status === 'confirming' && !state.players.some((player) => player.principalId === snapshot.principalId)) {
        throw new TypeError('Matchmaking cohort does not contain the requesting account');
    }
    return { scope, principalId: snapshot.principalId, observedAtEpochMs: snapshot.observedAtEpochMs, state };
}

function decodeState(value: unknown): MatchmakingState {
    const state = requireRecord(value, 'Matchmaking state');
    if (state.status === 'idle') {
        requireExactKeys(state, ['status'], 'Idle matchmaking state');
        return { status: 'idle' };
    }
    const searchId = assertValidRallarRouteId(state.searchId);
    if (searchId.length > 96) {
        throw new TypeError('Matchmaking search identity is too long');
    }
    switch (state.status) {
        case 'searching':
            requireExactKeys(state, ['status', 'searchId', 'expiresAtEpochMs'], 'Searching state');
            requireEpoch(state.expiresAtEpochMs, 'Search expiry');
            return { status: 'searching', searchId, expiresAtEpochMs: state.expiresAtEpochMs };
        case 'confirming':
            return decodeConfirmation(state, searchId);
        case 'matched': {
            requireExactKeys(state, ['status', 'searchId', 'roomRef', 'leaderPrincipalId'], 'Matched state');
            requireExactKeys(
                requireRecord(state.roomRef, 'Matched room'),
                ['applicationId', 'workspaceId', 'groupId'],
                'Matched room'
            );
            requireString(state.leaderPrincipalId, 'Matchmaking leader');
            const roomRef = assertValidRallarGroupRef(state.roomRef);
            requireString(roomRef.workspaceId, 'Matched workspace');
            return { status: 'matched', searchId, roomRef, leaderPrincipalId: state.leaderPrincipalId };
        }
        case 'ended':
            requireExactKeys(state, ['status', 'searchId', 'reason'], 'Ended state');
            return {
                status: 'ended',
                searchId,
                reason: requireOneOf(state.reason, [
                    'search-timeout',
                    'confirmation-timeout',
                    'cancelled',
                    'declined',
                    'admission-denied'
                ], 'Matchmaking outcome')
            };
        default:
            throw new TypeError('Matchmaking state is invalid');
    }
}

function decodeConfirmation(
    state: Readonly<Record<string, unknown>>,
    searchId: string
): Extract<MatchmakingState, { status: 'confirming'; }> {
    requireExactKeys(
        state,
        ['status', 'searchId', 'expiresAtEpochMs', 'leaderPrincipalId', 'players'],
        'Confirmation state'
    );
    requireEpoch(state.expiresAtEpochMs, 'Confirmation expiry');
    requireString(state.leaderPrincipalId, 'Matchmaking leader');
    if (!Array.isArray(state.players) || state.players.length < 2 || state.players.length > 16) {
        throw new TypeError('Matchmaking cohort size is invalid');
    }
    const players = state.players.map(decodePlayer);
    if (
        players[0]!.principalId !== state.leaderPrincipalId ||
        new Set(players.map((player) => player.principalId)).size !== players.length
    ) {
        throw new TypeError('Matchmaking cohort identities are invalid');
    }
    return {
        status: 'confirming',
        searchId,
        expiresAtEpochMs: state.expiresAtEpochMs,
        leaderPrincipalId: state.leaderPrincipalId,
        players
    };
}

function decodePlayer(value: unknown): MatchmakingPlayer {
    const player = requireRecord(value, 'Matchmaking player');
    requireExactKeys(player, ['principalId', 'confirmed'], 'Matchmaking player');
    requireString(player.principalId, 'Matchmaking player account');
    if (typeof player.confirmed !== 'boolean') {
        throw new TypeError('Matchmaking confirmation is invalid');
    }
    return { principalId: player.principalId, confirmed: player.confirmed };
}
