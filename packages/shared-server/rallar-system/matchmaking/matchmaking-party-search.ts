import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodePartyRef } from '@shared/api/parties/party-request.ts';
import type { PartyRef } from '@shared/api/parties/party.ts';
import { decodeStateScope } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { MatchmakingActor, MatchmakingPool, MatchmakingSearch } from './matchmaking-pool.ts';

export interface MatchmakingPartyStart {
    readonly ref: PartyRef;
    readonly rosterRevision: number;
    readonly leaderPrincipalId: string;
    readonly members: readonly MatchmakingActor[];
}

export interface MatchmakingPartySearch {
    readonly ref: PartyRef;
    readonly rosterRevision: number;
    readonly leaderPrincipalId: string;
    readonly searchIds: readonly string[];
}

interface MatchmakingSearchPhase {
    readonly search: MatchmakingSearch;
    readonly phase: string | null;
}

/** Party bindings extend the pool without changing existing individual search or result records. */
export function decodeMatchmakingPartySearches(
    value: unknown,
    pool: MatchmakingPool
): readonly MatchmakingPartySearch[] {
    if (!Array.isArray(value) || value.length > 1024) {
        throw new TypeError('Matchmaking party bindings must be an array');
    }
    const searches = new Map<string, MatchmakingSearchPhase>([
        ...pool.searching.map((search) => [search.searchId, { search, phase: null }] as const),
        ...pool.proposals.flatMap((proposal) =>
            proposal.participants.map((search) =>
                [search.searchId, { search, phase: proposal.roomRef.groupId }] as const
            )
        )
    ]);
    const partyIds = new Set<string>();
    const bound = new Set<string>();
    return value.map((candidate) => {
        const record = requireRecord(candidate, 'Matchmaking party binding');
        requireExactKeys(
            record,
            ['ref', 'rosterRevision', 'leaderPrincipalId', 'searchIds'],
            'Matchmaking party binding'
        );
        const ref = decodePartyRef(record.ref);
        requireEpoch(record.rosterRevision, 'Matchmaking party roster revision');
        requireString(record.leaderPrincipalId, 'Matchmaking party leader');
        if (
            ref.applicationId !== pool.scope.applicationId || ref.workspaceId !== pool.scope.workspaceId ||
            partyIds.has(ref.partyId)
        ) {
            throw new TypeError('Matchmaking party identity differs or is duplicated');
        }
        partyIds.add(ref.partyId);
        if (!Array.isArray(record.searchIds) || record.searchIds.length < 1 || record.searchIds.length > 16) {
            throw new TypeError('Matchmaking party roster size is invalid');
        }
        const searchIds = record.searchIds.map((identity) => {
            requireString(identity, 'Matchmaking party search identity');
            if (!searches.has(identity) || bound.has(identity)) {
                throw new TypeError('Matchmaking party has missing or overlapping search identities');
            }
            bound.add(identity);
            return identity;
        });
        const first = searches.get(searchIds[0]!)!;
        if (
            first.search.principalId !== record.leaderPrincipalId || searchIds.some((identity) => {
                const current = searches.get(identity)!;
                return current.phase !== first.phase ||
                    current.search.createdAtEpochMs !== first.search.createdAtEpochMs ||
                    current.search.expiresAtEpochMs !== first.search.expiresAtEpochMs;
            })
        ) {
            throw new TypeError('Matchmaking party has split phases, lifetimes or leadership');
        }
        return { ref, rosterRevision: record.rosterRevision, leaderPrincipalId: record.leaderPrincipalId, searchIds };
    });
}

export const MATCHMAKING_PARTIES_NAMESPACE = 'matchmaking:parties';

export function decodeMatchmakingPartyEntry(
    entry: RuntimeStateEntry | undefined,
    pool: MatchmakingPool
): readonly MatchmakingPartySearch[] {
    if (entry === undefined) {
        return [];
    }
    if (entry.key !== groupStateScopeStorageKey(pool.scope) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new TypeError('Matchmaking party storage identity or lifetime differs');
    }
    const record = requireRecord(JSON.parse(entry.value), 'Matchmaking party storage');
    requireExactKeys(record, ['scope', 'parties'], 'Matchmaking party storage');
    const scope = decodeStateScope(record.scope);
    if (scope.applicationId !== pool.scope.applicationId || scope.workspaceId !== pool.scope.workspaceId) {
        throw new TypeError('Matchmaking party storage scope differs');
    }
    return decodeMatchmakingPartySearches(record.parties, pool);
}
