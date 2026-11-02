import { requireEpoch } from '@shared/api/exact-object-decoding.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateInsert } from '../../runtime-state/postgres/insert-runtime-state.ts';
import type { RuntimeStateConditionalBatch } from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { decodeMatchmakingPool } from './decode-matchmaking-pool.ts';
import { decodeMatchmakingPartySearches, MATCHMAKING_PARTIES_NAMESPACE } from './matchmaking-party-search.ts';
import {
    activeMatchmakingSearches,
    type MatchmakingPool,
    type MatchmakingSearch,
    type MatchmakingTransition
} from './matchmaking-pool.ts';
import type { MatchmakingRepository } from './matchmaking-repository.ts';
import {
    MATCHMAKING_ACCOUNTS_NAMESPACE,
    MATCHMAKING_FINISHED_NAMESPACE,
    MATCHMAKING_POOLS_NAMESPACE,
    matchmakingAccountKey,
    matchmakingFinishedKey
} from './matchmaking-storage-codec.ts';

export interface MatchmakingStorageInput {
    readonly read: MatchmakingRepository.Read;
    readonly transition: MatchmakingTransition;
    readonly finishedRetentionMs: number;
}

export function computeMatchmakingStorage(
    input: MatchmakingStorageInput
): RuntimeStateConditionalBatch {
    const { read, transition, finishedRetentionMs } = input;
    const pool = decodeMatchmakingPool(transition.pool, read.pool.scope);
    requireEpoch(finishedRetentionMs, 'Finished search retention');
    if (finishedRetentionMs === 0) {
        throw new TypeError('Finished search retention must be positive');
    }
    const effects = computeSearchEffects(read, transition, finishedRetentionMs);
    const inserts: RuntimeStateInsert[] = [];
    const guardedEffects: RuntimeStateGuardedBatchEffect[] = [];
    for (const effect of effects) {
        if (effect.namespace === MATCHMAKING_ACCOUNTS_NAMESPACE && effect.operation === 'insert') {
            inserts.push({
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
    const parties = decodeMatchmakingPartySearches(transition.partySearches, pool);
    const partyValue = JSON.stringify({ scope: pool.scope, parties });
    if (read.partyEntry === null && parties.length > 0) {
        inserts.push({
            namespace: MATCHMAKING_PARTIES_NAMESPACE,
            key: groupStateScopeStorageKey(pool.scope),
            value: partyValue,
            expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
        });
    }
    else if (read.partyEntry !== null && partyValue !== read.partyEntry.value) {
        guardedEffects.push({
            effectId: 'parties',
            operation: 'update',
            namespace: MATCHMAKING_PARTIES_NAMESPACE,
            key: read.partyEntry.key,
            expectedRevision: read.partyEntry.revision,
            value: partyValue,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
    }
    return computePoolStorage(read, pool, guardedEffects, inserts);
}

function computePoolStorage(
    read: MatchmakingRepository.Read,
    pool: MatchmakingPool,
    guardedEffects: readonly RuntimeStateGuardedBatchEffect[],
    inserts: readonly RuntimeStateInsert[]
): RuntimeStateConditionalBatch {
    const batch = computeRuntimeStateGuardedBatchWrite({
        guard: {
            namespace: MATCHMAKING_POOLS_NAMESPACE,
            key: groupStateScopeStorageKey(pool.scope),
            value: JSON.stringify(pool),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            operation: 'update',
            expectedRevision: read.entry?.revision ?? 0
        },
        effects: guardedEffects
    });
    const creation = read.entry === null
        ? {
            namespace: MATCHMAKING_POOLS_NAMESPACE,
            key: groupStateScopeStorageKey(pool.scope),
            value: JSON.stringify(pool),
            expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
        }
        : null;
    return { creation, batch, inserts };
}

function computeSearchEffects(
    read: MatchmakingRepository.Read,
    transition: MatchmakingTransition,
    retentionMs: number
): RuntimeStateGuardedBatchEffect[] {
    const { pool } = transition;
    const previousIds = new Set(activeMatchmakingSearches(read.pool).map((search) => search.searchId));
    const active = activeMatchmakingSearches(pool);
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
            namespace: MATCHMAKING_FINISHED_NAMESPACE,
            key: matchmakingFinishedKey(pool.scope, search.principalId, search.searchId),
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
        namespace: MATCHMAKING_ACCOUNTS_NAMESPACE,
        key: matchmakingAccountKey(scope, search.principalId),
        value: JSON.stringify({ scope, principalId: search.principalId, searchId: search.searchId }),
        expireAtTimestamp
    };
}
