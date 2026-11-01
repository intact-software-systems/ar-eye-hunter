import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import { computeMatchmakingStorage, MatchmakingRepository, writeMatchmakingStorage } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
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
            readRuntimeStateBatch: async () => [{ selectorId: 'pool', entries: [] }, { selectorId: 'account', entries: [entry] }]
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
            await runtime.upsert('matchmaking:accounts', accountKey, corrupt, NEVER_EXPIRE_AT_TIMESTAMP);
            await expect(repository.read(scope, ['alice'])).rejects.toThrow(/identity/);
            await runtime.deleteByKey('matchmaking:accounts', accountKey);
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({ pool: read.pool, policy, nowEpochMs: 1000, command });
            await storage.sql.begin((sql) => writeMatchmakingStorage(sql, computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 })));
            await runtime.upsert('matchmaking:accounts', accountKey, corrupt, NEVER_EXPIRE_AT_TIMESTAMP);
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
            const transition = computeMatchmaking({ pool: read.pool, policy, nowEpochMs: 1000, command });
            const computed = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            const intervening = 'not-json';
            await runtime.upsert('matchmaking:accounts', accountKey, intervening, expiry);
            await expect(storage.sql.begin((sql) => writeMatchmakingStorage(sql, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
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
            await runtime.upsert('matchmaking:accounts', accountKey, previous, 10);
            expect((await repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: 1000 })).searchId).toBeNull();
            const read = await repository.read(scope, ['alice']);
            const transition = computeMatchmaking({ pool: read.pool, policy, nowEpochMs: 1000, command });
            const computed = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await runtime.upsert('matchmaking:accounts', accountKey, previous, 20);
            await expect(storage.sql.begin((sql) => writeMatchmakingStorage(sql, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await runtime.findEntry('matchmaking:pools', 'app=game:ws=default')).toBeUndefined();
            const refreshed = await repository.read(scope, ['alice']);
            await storage.sql.begin((sql) =>
                writeMatchmakingStorage(sql, computeMatchmakingStorage({ read: refreshed, transition, finishedRetentionMs: 60000 }))
            );
            expect((await repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: 1001 })).searchId).toBe('alice-search');
        }
        finally {
            await storage.close();
        }
    });
});
