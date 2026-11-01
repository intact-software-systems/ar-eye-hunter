import { describe, expect, it } from 'vitest';

import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import {
    computeMatchmakingStorage,
    MatchmakingRepository,
    writeMatchmakingStorage
} from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const policy = { players: 2, searchTimeoutMs: 120_000, confirmationTimeoutMs: 30_000, maxSearching: 256 };
const sessionLifetime = { sessionIssuedAtEpochMs: 1, sessionExpiresAtEpochMs: 8_000_000_000_000 };

function start(read: MatchmakingRepository.Read, principalId: string, now: number) {
    return computeMatchmakingStorage({
        read,
        transition: computeMatchmaking({
            pool: read.pool,
            policy,
            nowEpochMs: now,
            command: { action: 'start', principalId, sessionId: principalId, ...sessionLifetime, searchId: `search-${principalId}`, capturedAtEpochMs: now }
        }),
        finishedRetentionMs: 60000
    });
}

describe('durable matchmaking reservations', () => {
    it('fences competing matchers and permits the loser to recompute a single cohort', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_cas');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const stale = await repository.read(scope, ['alice', 'bob']);
            const now = Date.now();
            const alice = start(stale, 'alice', now);
            const bob = start(stale, 'bob', now + 1);
            await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, alice));
            await expect(storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, bob)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const refreshed = await repository.read(scope, ['bob']);
            await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, start(refreshed, 'bob', now + 1)));
            const committed = await repository.read(scope);
            expect(committed.pool.searching).toEqual([]);
            expect(committed.pool.proposals).toHaveLength(1);
            expect(committed.pool.proposals[0].participants.map((player) => player.principalId)).toEqual(['alice', 'bob']);
            expect((await repository.read({ ...scope, workspaceId: 'other' })).pool.proposals).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('persists terminal outcomes and releases the whole proposal in the same transaction', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_cancel');
        try {
            const repository = new MatchmakingRepository(new PSqlRuntimeStateRepository(storage.sql));
            const now = Date.now();
            for (const [index, principalId] of ['alice', 'bob'].entries()) {
                const read = await repository.read(scope, [principalId]);
                await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, start(read, principalId, now + index)));
            }
            const read = await repository.read(scope);
            const transition = computeMatchmaking({
                pool: read.pool,
                policy,
                nowEpochMs: now + 2,
                command: { action: 'cancel', principalId: 'bob', sessionId: 'bob', ...sessionLifetime, searchId: 'search-bob', capturedAtEpochMs: now + 2 }
            });
            const write = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await expect(storage.sql.begin(async (transaction) => {
                await writeMatchmakingStorage(transaction, write);
                throw new Error('later completion failed');
            })).rejects.toThrow('later completion failed');
            expect((await repository.read(scope)).pool.proposals).toHaveLength(1);
            expect(await repository.readFinished({ scope, principalId: 'alice', searchId: 'search-alice', nowEpochMs: now + 2 })).toBeNull();
            await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, write));
            expect((await repository.read(scope)).pool.proposals).toEqual([]);
            expect(await repository.readFinished({ scope, principalId: 'alice', searchId: 'search-alice', nowEpochMs: now + 2 })).toMatchObject({
                reason: 'declined'
            });
            expect(await repository.readFinished({ scope, principalId: 'bob', searchId: 'search-bob', nowEpochMs: now + 2 })).toMatchObject({
                reason: 'declined'
            });
            expect(await repository.readFinished({ scope, principalId: 'mallory', searchId: 'search-alice', nowEpochMs: now + 2 })).toBeNull();
        }
        finally {
            await storage.close();
        }
    });

    it('fails closed when a stored pool belongs to another workspace', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_corrupt');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            await runtime.upsert(
                'matchmaking:pools',
                'app=game:ws=default',
                JSON.stringify({
                    scope: { ...scope, workspaceId: 'other' },
                    searching: [],
                    proposals: []
                }),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
            await expect(new MatchmakingRepository(runtime).read(scope)).rejects.toThrow(/scope/i);
        }
        finally {
            await storage.close();
        }
    });
    it('recovers the matched room for both accounts after all confirmations commit', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_matched_recovery');
        try {
            const repository = new MatchmakingRepository(new PSqlRuntimeStateRepository(storage.sql));
            const now = Date.now();
            for (const [index, principalId] of ['alice', 'bob'].entries()) {
                const read = await repository.read(scope, [principalId]);
                await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, start(read, principalId, now + index)));
            }
            for (const [index, principalId] of ['alice', 'bob'].entries()) {
                const read = await repository.read(scope, [principalId]);
                const transition = computeMatchmaking({
                    pool: read.pool,
                    policy,
                    nowEpochMs: now + 2 + index,
                    command: {
                        action: 'confirm',
                        principalId,
                        sessionId: principalId,
                        ...sessionLifetime,
                        searchId: `search-${principalId}`,
                        capturedAtEpochMs: now + 2 + index
                    }
                });
                const write = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
                await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, write));
            }
            for (const principalId of ['alice', 'bob']) {
                expect(await repository.readFinished({ scope, principalId: principalId, searchId: `search-${principalId}`, nowEpochMs: now + 4 }))
                    .toMatchObject({
                        reason: 'matched',
                        leaderPrincipalId: 'alice',
                        roomRef: { ...scope, groupId: 'match-search-alice' }
                    });
            }
        }
        finally {
            await storage.close();
        }
    });
    it('recovers an account search without a browser-local search identity', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_account_recovery');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const now = Date.now();
            const initial = await repository.read(scope, ['alice']);
            await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, start(initial, 'alice', now)));
            const restarted = new MatchmakingRepository(runtime);
            const recovered = await restarted.readCurrent({ scope, principalId: 'alice', nowEpochMs: now + 1 });
            expect(recovered.searchId).toBe('search-alice');
            expect(recovered.pool.searching).toMatchObject([{ principalId: 'alice' }]);
            expect((await restarted.readCurrent({ scope, principalId: 'bob', nowEpochMs: now + 1 })).searchId).toBeNull();
            expect((await restarted.readCurrent({ scope: { ...scope, applicationId: 'another-game' }, principalId: 'alice', nowEpochMs: now + 1 })).searchId)
                .toBeNull();
        }
        finally {
            await storage.close();
        }
    });
    it('keeps one recovery pointer when both an old search and a delayed replacement expire together', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_delayed_replacement');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new MatchmakingRepository(runtime);
            const now = Date.now();
            const first = await repository.read(scope, ['alice']);
            await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, start(first, 'alice', now)));
            const read = await repository.read(scope);
            const transition = computeMatchmaking({
                pool: read.pool,
                policy,
                nowEpochMs: now + 120002,
                command: { action: 'start', principalId: 'alice', sessionId: 'alice', ...sessionLifetime, searchId: 'replacement', capturedAtEpochMs: now + 1 }
            });
            const write = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
            await storage.sql.begin((transaction) => writeMatchmakingStorage(transaction, write));
            const recovered = await repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: now + 120003 });
            expect(recovered.searchId).toBe('replacement');
            expect(recovered.finished?.reason).toBe('search-timeout');
        }
        finally {
            await storage.close();
        }
    });
});
