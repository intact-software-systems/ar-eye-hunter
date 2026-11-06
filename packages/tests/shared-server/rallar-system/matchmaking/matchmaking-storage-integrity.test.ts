import { computeMatchmakingStorage } from '@shared-server/rallar-system/matchmaking/compute-matchmaking-storage.ts';
import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import { MatchmakingRepository } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeRuntimeStateConditionalBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const accountKey = 'app=game:ws=default:principal=alice';
const policy = { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 };
const command = {
    action: 'start' as const,
    principalId: 'alice',
    sessionId: 'alice-session',
    sessionIssuedAtEpochMs: 1,
    sessionExpiresAtEpochMs: 8000000000000,
    searchId: 'alice-search',
    capturedAtEpochMs: 1000
};

describe('matchmaking persisted identity and pointer guards', () => {
    it.each([
        { key: 'wrong-slot', value: '{}' },
        { key: accountKey, value: 'not-json' },
        { key: accountKey, value: JSON.stringify({ scope: { ...scope, workspaceId: 'other' }, principalId: 'alice', searchId: 'alice-search' }) }
    ])('rejects expired invalid account and terminal records before absence: $key $value', async ({ key, value }) => {
        const entry = { key, value, revision: 1, updatedTimestamp: new Date(1).toISOString(), expireAtTimestamp: 10 };
        const repository = new MatchmakingRepository({
            findEntry: async () => ({ ...entry, key: key === accountKey ? `${accountKey}:search=alice-search` : key }),
            readRuntimeStateBatch:
                async () => [{ selectorId: 'pool', entries: [] }, { selectorId: 'account', entries: [entry] }, { selectorId: 'parties', entries: [] }, {
                    selectorId: 'party-account',
                    entries: []
                }]
        });
        await expect(repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: 20 })).rejects.toThrow();
        await expect(repository.readFinished({ scope, principalId: 'alice', searchId: 'alice-search', nowEpochMs: 20 })).rejects.toThrow();
    });

    it('refuses corrupt account pointers during start, cancellation and expiry reads instead of repairing them', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_pointer_corruption');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const corrupt = JSON.stringify({ scope, principalId: 'mallory', searchId: 'alice-search' });
            await runtime.upsert({ namespace: 'matchmaking:accounts', key: accountKey, value: corrupt, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            await expect(repository.read(scope, ['alice'])).rejects.toThrow(/identity/);
            await runtime.deleteByKey('matchmaking:accounts', accountKey);
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({ partySearches: [], pool: read.pool, policy, nowEpochMs: 1000, command });
            const prepared = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await storage.sql.begin((sql) => writeRuntimeStateConditionalBatch(sql, prepared));
            await runtime.upsert({ namespace: 'matchmaking:accounts', key: accountKey, value: corrupt, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            await expect(repository.read(scope, ['alice'])).rejects.toThrow(/identity/);
            await expect(repository.read(scope, [])).rejects.toThrow(/identity/);
            expect((await runtime.findEntry('matchmaking:accounts', accountKey))?.value).toBe(corrupt);
        }
        finally {
            await storage.close();
        }
    });

    it.each([NEVER_EXPIRE_AT_TIMESTAMP, 1])('rolls back when an absent pointer gains an intervening row expiring at %s', async (expiry) => {
        const storage = await createResourceInboxTestStorage('matchmaking_pointer_cas');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({ partySearches: [], pool: read.pool, policy, nowEpochMs: 1000, command });
            const computed = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            const intervening = 'not-json';
            await runtime.upsert({ namespace: 'matchmaking:accounts', key: accountKey, value: intervening, expireAtTimestamp: expiry });
            await expect(storage.sql.begin((sql) => writeRuntimeStateConditionalBatch(sql, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await runtime.findEntry('matchmaking:pools', 'app=game:ws=default')).toBeUndefined();
            expect((await runtime.findEntry('matchmaking:accounts', accountKey))?.value).toBe(intervening);
        }
        finally {
            await storage.close();
        }
    });
    it('fences an existing pointer revision and can replace a validated expired pointer', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_pointer_revision');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const previous = JSON.stringify({ scope, principalId: 'alice', searchId: 'previous-search' });
            await runtime.upsert({ namespace: 'matchmaking:accounts', key: accountKey, value: previous, expireAtTimestamp: 10 });
            expect((await repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: 1000 })).searchId).toBeNull();
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({ partySearches: [], pool: read.pool, policy, nowEpochMs: 1000, command });
            const computed = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await runtime.upsert({ namespace: 'matchmaking:accounts', key: accountKey, value: previous, expireAtTimestamp: 20 });
            await expect(storage.sql.begin((sql) => writeRuntimeStateConditionalBatch(sql, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await runtime.findEntry('matchmaking:pools', 'app=game:ws=default')).toBeUndefined();
            const refreshed = await repository.read(scope, ['alice']);
            const refreshedWrite = computeMatchmakingStorage({ read: refreshed, transition, finishedRetentionMs: 60000 });
            await storage.sql.begin((sql) => writeRuntimeStateConditionalBatch(sql, refreshedWrite));
            expect((await repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: 1001 })).searchId).toBe('alice-search');
        }
        finally {
            await storage.close();
        }
    });
    it('preserves an intervening expired pool row when the attempt observed physical absence', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_pool_absence');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({
                partySearches: [],
                pool: read.pool,
                policy,
                nowEpochMs: 1000,
                command: {
                    action: 'start',
                    principalId: 'alice',
                    sessionId: 'alice',
                    sessionIssuedAtEpochMs: 1,
                    sessionExpiresAtEpochMs: 1000000,
                    searchId: 'alice-search',
                    capturedAtEpochMs: 1000
                }
            });
            const computed = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await runtime.upsert({ namespace: 'matchmaking:pools', key: 'app=game:ws=default', value: 'intervening expired row', expireAtTimestamp: 1 });
            await expect(storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await runtime.findEntry('matchmaking:pools', 'app=game:ws=default'))?.value).toBe('intervening expired row');
            expect(await runtime.findEntry('matchmaking:accounts', 'app=game:ws=default:principal=alice')).toBeUndefined();
        }
        finally {
            await storage.close();
        }
    });
    it('rejects an active search whose party binding is missing on recovery as well as mutation reads', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_party_pointer_corruption');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({ partySearches: [], pool: read.pool, policy, nowEpochMs: 1000, command });
            const computed = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await storage.sql.begin((sql) => writeRuntimeStateConditionalBatch(sql, computed));
            const corrupt = JSON.stringify({ scope, principalId: 'alice', partyId: 'lost-binding', invitations: [] });
            await runtime.upsert({ namespace: 'parties:accounts', key: accountKey, value: corrupt, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            await expect(repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: 1001 })).rejects.toThrow(/binding/);
            await expect(repository.read(scope)).rejects.toThrow(/binding/);
            expect((await runtime.findEntry('parties:accounts', accountKey))?.value).toBe(corrupt);
        }
        finally {
            await storage.close();
        }
    });
});
