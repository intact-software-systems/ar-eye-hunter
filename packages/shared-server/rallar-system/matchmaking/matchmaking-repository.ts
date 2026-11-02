import type { StateScope } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { PARTY_ACCOUNTS_NAMESPACE, partyAccountKey } from '../parties/persistence/party-account.ts';
import { decodePartyAccountEntry, type PartyRepository } from '../parties/persistence/party-repository.ts';
import { activeMatchmakingSearches } from './matchmaking-pool.ts';
import {
    MATCHMAKING_ACCOUNTS_NAMESPACE,
    MATCHMAKING_FINISHED_NAMESPACE,
    MATCHMAKING_POOLS_NAMESPACE
} from './matchmaking-storage-codec.ts';

import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { assertRuntimeStateReadBatchResult } from '../../runtime-state/read-batch/assert-runtime-state-read-batch-result.ts';
import type { RuntimeStateReadBatchSelector } from '../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeMatchmakingPool } from './decode-matchmaking-pool.ts';
import {
    decodeMatchmakingPartyEntry,
    MATCHMAKING_PARTIES_NAMESPACE,
    type MatchmakingPartySearch
} from './matchmaking-party-search.ts';
import type {
    MatchmakingFinished,
    MatchmakingPool
} from './matchmaking-pool.ts';

import {
    decodeMatchmakingAccountEntry,
    decodeMatchmakingFinishedEntry,
    matchmakingAccountKey,
    matchmakingFinishedKey
} from './matchmaking-storage-codec.ts';

export namespace MatchmakingRepository {
    export interface Read {
        readonly partyEntry: RuntimeStateEntry | null;
        readonly partyAccounts: Readonly<Record<string, PartyRepository.AccountRead>>;
        readonly partySearches: readonly MatchmakingPartySearch[];
        readonly entry: RuntimeStateEntry | null;
        readonly pool: MatchmakingPool;
        readonly accounts: Readonly<Record<string, RuntimeStateEntry | null>>;
    }

    export interface FinishedIdentity {
        readonly scope: StateScope;
        readonly principalId: string;
        readonly searchId: string;
    }

    export interface FinishedRead extends FinishedIdentity {
        readonly nowEpochMs: number;
    }

    export interface AccountRead {
        readonly scope: StateScope;
        readonly principalId: string;
        readonly nowEpochMs: number;
    }

    export interface Current {
        readonly pool: MatchmakingPool;
        readonly searchId: string | null;
        readonly finished: MatchmakingFinished | null;
    }
}

/** The scope's pool CAS fences cohort selection and each account's current search together. */
export class MatchmakingRepository {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;

    constructor(runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>) {
        this.runtime = runtime;
    }

    async read(scope: StateScope, principalIds: readonly string[] = []): Promise<MatchmakingRepository.Read> {
        const key = groupStateScopeStorageKey(scope);
        const initial = decodeStoredPool(scope, await this.runtime.findEntry(MATCHMAKING_POOLS_NAMESPACE, key));
        const active = activeMatchmakingSearches(initial.pool);
        const principals = [...new Set([...active.map((search) => search.principalId), ...principalIds])];
        const selectors = matchmakingReadSelectors(scope, principals);
        const selections = assertRuntimeStateReadBatchResult(
            selectors,
            await this.runtime.readRuntimeStateBatch(selectors)
        );
        const read = decodeStoredPool(scope, selections[0].entries[0]);
        if (read.entry?.revision !== initial.entry?.revision || read.entry?.value !== initial.entry?.value) {
            throw new RuntimeStateWriteConflictError();
        }
        const searches = new Map(active.map((search) => [search.principalId, search]));
        const accounts = new Map<string, RuntimeStateEntry | null>();
        for (const [index, principalId] of principals.entries()) {
            const entry = selections[index + 2].entries[0];
            const searchId = entry === undefined ? null : decodeMatchmakingAccountEntry(entry, { scope, principalId });
            const current = searches.get(principalId);
            if (
                current !== undefined &&
                (searchId !== current.searchId || entry?.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP)
            ) {
                throw new TypeError('Active matchmaking search has lost its account lookup');
            }
            accounts.set(principalId, entry ?? null);
        }
        const partyEntry = selections[1].entries[0];
        const partyAccounts = Object.fromEntries(
            principals.map((
                principalId,
                index
            ) => [
                principalId,
                decodePartyAccountEntry(selections[2 + principals.length + index].entries[0], scope, principalId)
            ])
        );
        const partySearches = decodeMatchmakingPartyEntry(partyEntry, read.pool);
        for (const search of active) {
            const binding = partySearches.find((party) => party.searchIds.includes(search.searchId));
            if ((binding?.ref.partyId ?? null) !== partyAccounts[search.principalId]!.account.partyId) {
                throw new TypeError('Matchmaking search and party membership binding differ');
            }
        }
        return {
            ...read,
            partyEntry: partyEntry ?? null,
            partySearches,
            partyAccounts,
            accounts: Object.fromEntries(accounts)
        };
    }

    async readCurrent(input: MatchmakingRepository.AccountRead): Promise<MatchmakingRepository.Current> {
        const { scope, principalId, nowEpochMs } = input;
        const selectors: RuntimeStateReadBatchSelector[] = [
            {
                selectorId: 'pool',
                kind: 'key',
                namespace: MATCHMAKING_POOLS_NAMESPACE,
                key: groupStateScopeStorageKey(scope)
            },
            {
                selectorId: 'account',
                kind: 'key',
                namespace: MATCHMAKING_ACCOUNTS_NAMESPACE,
                key: matchmakingAccountKey(scope, principalId)
            },
            {
                selectorId: 'parties',
                kind: 'key',
                namespace: MATCHMAKING_PARTIES_NAMESPACE,
                key: groupStateScopeStorageKey(scope)
            },
            {
                selectorId: 'party-account',
                kind: 'key',
                namespace: PARTY_ACCOUNTS_NAMESPACE,
                key: partyAccountKey(scope, principalId)
            }
        ];
        const selections = assertRuntimeStateReadBatchResult(
            selectors,
            await this.runtime.readRuntimeStateBatch(selectors)
        );
        const { pool } = decodeStoredPool(scope, selections[0].entries[0]);
        const partySearches = decodeMatchmakingPartyEntry(selections[2].entries[0], pool);
        const partyAccount = decodePartyAccountEntry(selections[3].entries[0], scope, principalId);
        const active = activeMatchmakingSearches(pool).find((search) => search.principalId === principalId);
        if (
            active !== undefined &&
            (partySearches.find((party) => party.searchIds.includes(active.searchId))?.ref.partyId ?? null) !==
                partyAccount.account.partyId
        ) {
            throw new TypeError('Matchmaking search and party membership binding differ');
        }
        const entry = selections[1].entries[0];
        const decodedSearchId = entry === undefined ? null : decodeMatchmakingAccountEntry(entry, input);
        const searchId = entry !== undefined && entry.expireAtTimestamp > nowEpochMs ? decodedSearchId : null;
        if (active !== undefined && searchId !== active.searchId) {
            throw new TypeError('Active matchmaking search has lost its account lookup');
        }
        const finished = searchId === null || active !== undefined
            ? null
            : await this.readFinished({ ...input, searchId });
        return { pool, searchId: active?.searchId ?? finished?.searchId ?? null, finished };
    }

    async readFinished(input: MatchmakingRepository.FinishedRead): Promise<MatchmakingFinished | null> {
        const { scope, principalId, searchId, nowEpochMs } = input;
        const key = matchmakingFinishedKey(scope, principalId, searchId);
        const entry = await this.runtime.findEntry(MATCHMAKING_FINISHED_NAMESPACE, key);
        if (entry === undefined) {
            return null;
        }
        const search = decodeMatchmakingFinishedEntry(entry, input);
        return entry.expireAtTimestamp <= nowEpochMs ? null : search;
    }
}

function decodeStoredPool(
    scope: StateScope,
    entry: RuntimeStateEntry | undefined
): Pick<MatchmakingRepository.Read, 'entry' | 'pool'> {
    if (entry === undefined) {
        return { entry: null, pool: { scope, searching: [], proposals: [] } };
    }
    if (entry.key !== groupStateScopeStorageKey(scope) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new TypeError('Matchmaking pool storage identity or lifetime differs');
    }
    return { entry, pool: decodeMatchmakingPool(JSON.parse(entry.value), scope) };
}

function matchmakingReadSelectors(scope: StateScope, principals: readonly string[]): RuntimeStateReadBatchSelector[] {
    const key = groupStateScopeStorageKey(scope);
    return [
        { selectorId: 'pool', kind: 'key', namespace: MATCHMAKING_POOLS_NAMESPACE, key },
        { selectorId: 'parties', kind: 'key', namespace: MATCHMAKING_PARTIES_NAMESPACE, key },
        ...principals.map((principalId, index): RuntimeStateReadBatchSelector => ({
            selectorId: `account:${index}`,
            kind: 'key',
            namespace: MATCHMAKING_ACCOUNTS_NAMESPACE,
            key: matchmakingAccountKey(scope, principalId)
        })),
        ...principals.map((principalId, index): RuntimeStateReadBatchSelector => ({
            selectorId: `party-account:${index}`,
            kind: 'key',
            namespace: PARTY_ACCOUNTS_NAMESPACE,
            key: partyAccountKey(scope, principalId)
        }))
    ];
}
