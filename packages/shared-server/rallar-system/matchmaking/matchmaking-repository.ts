import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchWrite
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { insertRuntimeState, type RuntimeStateInsert } from '../../runtime-state/postgres/insert-runtime-state.ts';
import { writeRuntimeStateGuardedBatch } from '../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import { assertRuntimeStateReadBatchResult } from '../../runtime-state/read-batch/assert-runtime-state-read-batch-result.ts';
import type { RuntimeStateReadBatchSelector } from '../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeMatchmakingPool } from './decode-matchmaking-pool.ts';
import type {
    MatchmakingFinished,
    MatchmakingPool,
    MatchmakingSearch,
    MatchmakingTransition
} from './matchmaking-pool.ts';

const POOLS_NAMESPACE = 'matchmaking:pools';
const FINISHED_NAMESPACE = 'matchmaking:finished';
const ACCOUNTS_NAMESPACE = 'matchmaking:accounts';

export namespace MatchmakingRepository {
    export interface Read {
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

    export interface StorageWrite {
        readonly batch: RuntimeStateGuardedBatchWrite;
        readonly accountInserts: readonly RuntimeStateInsert[];
    }

    export interface StorageInput {
        readonly read: Read;
        readonly transition: MatchmakingTransition;
        readonly finishedRetentionMs: number;
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
        const initial = decodeStoredPool(scope, await this.runtime.findEntry(POOLS_NAMESPACE, key));
        const active = activeSearches(initial.pool);
        const principals = [...new Set([...active.map((search) => search.principalId), ...principalIds])];
        const selectors: RuntimeStateReadBatchSelector[] = [
            { selectorId: 'pool', kind: 'key', namespace: POOLS_NAMESPACE, key },
            ...principals.map((principalId, index): RuntimeStateReadBatchSelector => ({
                selectorId: `account:${index}`,
                kind: 'key',
                namespace: ACCOUNTS_NAMESPACE,
                key: accountKey(scope, principalId)
            }))
        ];
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
            const entry = selections[index + 1].entries[0];
            const searchId = entry === undefined ? null : decodeAccountLookup(entry, { scope, principalId });
            const current = searches.get(principalId);
            if (
                current !== undefined &&
                (searchId !== current.searchId || entry?.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP)
            ) {
                throw new TypeError('Active matchmaking search has lost its account lookup');
            }
            accounts.set(principalId, entry ?? null);
        }
        return { ...read, accounts: Object.fromEntries(accounts) };
    }

    async readCurrent(input: MatchmakingRepository.AccountRead): Promise<MatchmakingRepository.Current> {
        const { scope, principalId, nowEpochMs } = input;
        const selections = await this.runtime.readRuntimeStateBatch([
            { selectorId: 'pool', kind: 'key', namespace: POOLS_NAMESPACE, key: groupStateScopeStorageKey(scope) },
            { selectorId: 'account', kind: 'key', namespace: ACCOUNTS_NAMESPACE, key: accountKey(scope, principalId) }
        ]);
        if (
            selections.length !== 2 || selections[0].selectorId !== 'pool' || selections[1].selectorId !== 'account' ||
            selections.some((selection) => selection.entries.length > 1)
        ) {
            throw new TypeError('Matchmaking recovery batch identities differ');
        }
        const { pool } = decodeStoredPool(scope, selections[0].entries[0]);
        const active = activeSearches(pool).find((search) => search.principalId === principalId);
        const entry = selections[1].entries[0];
        const decodedSearchId = entry === undefined ? null : decodeAccountLookup(entry, input);
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
        const key = finishedKey(scope, principalId, searchId);
        const entry = await this.runtime.findEntry(FINISHED_NAMESPACE, key);
        if (entry === undefined) {
            return null;
        }
        if (entry.key !== key) {
            throw new TypeError('Finished search storage key differs');
        }
        const stored = requireRecord(JSON.parse(entry.value), 'Finished search record');
        requireExactKeys(stored, ['scope', 'search'], 'Finished search record');
        if (!jsonEquals(stored.scope, scope)) {
            throw new TypeError('Finished search scope differs');
        }
        const search = decodeFinishedSearch(stored.search, input);
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

function decodeAccountLookup(
    entry: RuntimeStateEntry,
    input: Pick<MatchmakingRepository.AccountRead, 'scope' | 'principalId'>
): string {
    const { scope, principalId } = input;
    const value = requireRecord(JSON.parse(entry.value), 'Search account lookup');
    requireExactKeys(value, ['scope', 'principalId', 'searchId'], 'Search account lookup');
    requireString(value.searchId, 'Account search identity');
    if (
        entry.key !== accountKey(scope, principalId) || value.principalId !== principalId ||
        !jsonEquals(value.scope, scope)
    ) {
        throw new TypeError('Search account lookup identity differs');
    }
    return value.searchId;
}

export function computeMatchmakingStorage(
    input: MatchmakingRepository.StorageInput
): MatchmakingRepository.StorageWrite {
    const { read, transition, finishedRetentionMs } = input;
    const pool = decodeMatchmakingPool(transition.pool, read.pool.scope);
    requireEpoch(finishedRetentionMs, 'Finished search retention');
    if (finishedRetentionMs === 0) {
        throw new TypeError('Finished search retention must be positive');
    }
    const effects = computeSearchEffects(read, transition, finishedRetentionMs);
    const accountInserts: RuntimeStateInsert[] = [];
    const guardedEffects: RuntimeStateGuardedBatchEffect[] = [];
    for (const effect of effects) {
        if (effect.namespace === ACCOUNTS_NAMESPACE && effect.operation === 'insert') {
            accountInserts.push({
                namespace: effect.namespace,
                key: effect.key,
                value: effect.value,
                expireAtIsoTimestamp: new Date(effect.expireAtTimestamp).toISOString()
            });
        }
        else {
            guardedEffects.push(effect);
        }
    }
    const batch = computeRuntimeStateGuardedBatchWrite({
        guard: {
            namespace: POOLS_NAMESPACE,
            key: groupStateScopeStorageKey(pool.scope),
            value: JSON.stringify(pool),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            ...(read.entry === null
                ? { operation: 'insert' }
                : { operation: 'update', expectedRevision: read.entry.revision })
        },
        effects: guardedEffects
    });
    return { batch, accountInserts };
}

export async function writeMatchmakingStorage(
    transaction: PSqlSql,
    storage: MatchmakingRepository.StorageWrite
): Promise<void> {
    const result = await writeRuntimeStateGuardedBatch(transaction, storage.batch);
    if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
    for (const insert of storage.accountInserts) {
        await insertRuntimeState(transaction, insert);
    }
}

function computeSearchEffects(
    read: MatchmakingRepository.Read,
    transition: MatchmakingTransition,
    retentionMs: number
): RuntimeStateGuardedBatchEffect[] {
    const { pool } = transition;
    const previousIds = new Set(activeSearches(read.pool).map((search) => search.searchId));
    const active = activeSearches(pool);
    const activePrincipals = new Set(active.map((search) => search.principalId));
    const lookups = new Map<string, RuntimeStateGuardedBatchEffect>();
    for (const search of active) {
        if (!previousIds.has(search.searchId)) {
            lookups.set(search.principalId, accountLookup(read, search, NEVER_EXPIRE_AT_TIMESTAMP));
        }
    }
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    for (const search of transition.finished) {
        const expireAtTimestamp = search.completedAtEpochMs + retentionMs;
        effects.push({
            effectId: `finished:${search.searchId}`,
            operation: 'insert',
            namespace: FINISHED_NAMESPACE,
            key: finishedKey(pool.scope, search.principalId, search.searchId),
            value: JSON.stringify({ scope: pool.scope, search }),
            expireAtTimestamp
        });
        // Expiry precedes the command, so its new outcome replaces the expired predecessor's pointer.
        if (!activePrincipals.has(search.principalId)) {
            lookups.set(search.principalId, accountLookup(read, search, expireAtTimestamp));
        }
    }
    return [...effects, ...lookups.values()];
}

function activeSearches(pool: MatchmakingPool): readonly MatchmakingSearch[] {
    return [...pool.searching, ...pool.proposals.flatMap((proposal) => proposal.participants)];
}

function accountLookup(
    read: MatchmakingRepository.Read,
    search: MatchmakingSearch,
    expireAtTimestamp: number
): RuntimeStateGuardedBatchEffect {
    const scope = read.pool.scope;
    const entry = Object.hasOwn(read.accounts, search.principalId) ? read.accounts[search.principalId] : undefined;
    if (entry === undefined) {
        throw new TypeError('Matchmaking account write requires an observed pointer');
    }
    return {
        effectId: `account:${search.principalId}`,
        ...(entry === null
            ? { operation: 'insert' as const }
            : { operation: 'update' as const, expectedRevision: entry.revision }),
        namespace: ACCOUNTS_NAMESPACE,
        key: accountKey(scope, search.principalId),
        value: JSON.stringify({ scope, principalId: search.principalId, searchId: search.searchId }),
        expireAtTimestamp
    };
}

function accountKey(scope: StateScope, principalId: string): string {
    requireString(principalId, 'Matchmaking account');
    return `${groupStateScopeStorageKey(scope)}:principal=${encodeURIComponent(principalId)}`;
}

function finishedKey(scope: StateScope, principalId: string, searchId: string): string {
    requireString(searchId, 'Matchmaking search');
    return `${accountKey(scope, principalId)}:search=${encodeURIComponent(searchId)}`;
}

function decodeFinishedSearch(value: unknown, identity: MatchmakingRepository.FinishedIdentity): MatchmakingFinished {
    const { scope, principalId, searchId } = identity;
    const search = requireRecord(value, 'Finished search');
    requireExactKeys(search, [
        'searchId',
        'principalId',
        'sessionId',
        'sessionIssuedAtEpochMs',
        'sessionExpiresAtEpochMs',
        'createdAtEpochMs',
        'expiresAtEpochMs',
        'completedAtEpochMs',
        'reason',
        'roomRef',
        'leaderPrincipalId'
    ], 'Finished search');
    if (search.principalId !== principalId || search.searchId !== searchId) {
        throw new TypeError('Finished search account or search identity differs');
    }
    requireString(search.sessionId, 'Finished search session');
    requireEpoch(search.sessionIssuedAtEpochMs, 'Finished search session issuance');
    requireEpoch(search.sessionExpiresAtEpochMs, 'Finished search session expiry');
    requireEpoch(search.createdAtEpochMs, 'Finished search creation');
    requireEpoch(search.expiresAtEpochMs, 'Finished search deadline');
    requireEpoch(search.completedAtEpochMs, 'Finished search completion');
    const reason = requireOneOf(search.reason, [
        'search-timeout',
        'confirmation-timeout',
        'cancelled',
        'declined',
        'matched',
        'admission-denied'
    ], 'Finished search reason');
    if (search.completedAtEpochMs < search.createdAtEpochMs || search.expiresAtEpochMs <= search.createdAtEpochMs) {
        throw new TypeError('Finished search lifetime is invalid');
    }
    const destination = decodeFinishedDestination(search, scope, reason);
    return {
        principalId,
        searchId,
        sessionId: search.sessionId,
        sessionIssuedAtEpochMs: search.sessionIssuedAtEpochMs,
        sessionExpiresAtEpochMs: search.sessionExpiresAtEpochMs,
        createdAtEpochMs: search.createdAtEpochMs,
        expiresAtEpochMs: search.expiresAtEpochMs,
        completedAtEpochMs: search.completedAtEpochMs,
        reason,
        ...destination
    };
}

function decodeFinishedDestination(
    value: unknown,
    scope: StateScope,
    reason: MatchmakingFinished['reason']
): Pick<MatchmakingFinished, 'roomRef' | 'leaderPrincipalId'> {
    const search = requireRecord(value, 'Finished search destination');
    if (reason !== 'matched') {
        if (search.roomRef !== null || search.leaderPrincipalId !== null) {
            throw new TypeError('An unsuccessful search cannot grant a destination');
        }
        return { roomRef: null, leaderPrincipalId: null };
    }
    const room = requireRecord(search.roomRef, 'Matched destination');
    requireExactKeys(room, ['applicationId', 'workspaceId', 'groupId'], 'Matched destination');
    requireString(room.groupId, 'Matched group');
    requireString(search.leaderPrincipalId, 'Matched leader');
    if (room.applicationId !== scope.applicationId || room.workspaceId !== scope.workspaceId) {
        throw new TypeError('Matched destination scope differs');
    }
    return { roomRef: { ...scope, groupId: room.groupId }, leaderPrincipalId: search.leaderPrincipalId };
}
