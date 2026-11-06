import { writeTournamentGame } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import {
    computeTournamentResultPublication,
    TOURNAMENT_ATTEMPTS_NAMESPACE,
    TOURNAMENT_RESULTS_NAMESPACE,
    TournamentResultRepository
} from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { createTournamentResult, tournamentResultKey } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeRuntimeStateConditionalBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const binding: TournamentMatchBinding = {
    tournamentRef: { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' },
    slot: 'semifinal-1',
    attemptId: 'attempt-1',
    roomRef: { applicationId: 'game', workspaceId: 'default', groupId: 'arena' },
    gameId: 'game-1',
    rulesId: 'native-v1',
    principalIds: ['alice', 'bob']
};
const attemptKey = 'app=game:ws=default:group=arena';
const active = { binding, status: 'playing', startedAtEpochMs: 1000 };
const result = createTournamentResult({
    binding,
    authority: { kind: 'server', id: 'owner', epoch: 1 },
    startedAtEpochMs: 1000,
    finishedAtEpochMs: 61000,
    scores: [100, 0]
});

describe('tournament immutable result persistence', () => {
    it('resolves the private attempt from its scoped room without trusting browser metadata', async () => {
        const storage = await createResourceInboxTestStorage('tournament_room_binding');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new TournamentResultRepository(runtime);
            expect(await repository.readRoom(binding.roomRef)).toBeNull();
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: 'app=game:ws=default:group=arena',
                value: JSON.stringify(active),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            expect((await repository.readRoom(binding.roomRef))?.binding).toEqual(binding);
            expect(await repository.readRoom({ ...binding.roomRef, workspaceId: 'other' })).toBeNull();
            await runtime.upsert(
                {
                    namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                    key: 'app=game:ws=default:group=arena',
                    value: JSON.stringify({ ...active, binding: { ...binding, roomRef: { ...binding.roomRef, groupId: 'other' } } }),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                }
            );
            await expect(repository.readRoom(binding.roomRef)).rejects.toThrow(/room/);
        }
        finally {
            await storage.close();
        }
    });

    it('publishes once and returns the exact fact on replay, refusing a conflicting finish', async () => {
        const storage = await createResourceInboxTestStorage('tournament_result_replay');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new TournamentResultRepository(runtime);
            const key = tournamentResultKey(binding);
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: attemptKey,
                value: JSON.stringify(active),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const read = await repository.read(binding);
            const computed = computeTournamentResultPublication(read, result, Date.now());
            expect(computed.kind).toBe('publish');
            if (computed.kind !== 'publish') {
                throw new Error('Expected first publication');
            }
            await storage.sql.begin((transaction) => writeTournamentGame(transaction, computed.write));
            const finished = await repository.read(binding);
            expect(finished.attempt?.status).toBe('finished');
            expect(finished.result).toEqual(result);
            const signals = await storage.sql<
                readonly { count: number; }[]
            >`select count(*)::integer as count from resource_inbox where ri_topic_id = 'app:rallar-tournaments:reconcile'`;
            expect(signals[0].count).toBe(1);
            expect(computeTournamentResultPublication(finished, result, Date.now())).toEqual({ kind: 'replay', result });
            const replacement = createTournamentResult({
                binding,
                authority: result.authority,
                startedAtEpochMs: 1000,
                finishedAtEpochMs: 61000,
                scores: [0, 100]
            });
            expect(() => computeTournamentResultPublication(finished, replacement, Date.now())).toThrow(/immutable/);
            expect((await repository.read(binding)).result).toEqual(result);
        }
        finally {
            await storage.close();
        }
    });

    it('rolls back a final game save when cancellation wins after the finalizer read', async () => {
        const storage = await createResourceInboxTestStorage('tournament_result_cancel');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new TournamentResultRepository(runtime);
            const key = tournamentResultKey(binding);
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: attemptKey,
                value: JSON.stringify(active),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const computed = computeTournamentResultPublication(await repository.read(binding), result, Date.now());
            if (computed.kind !== 'publish') {
                throw new Error('Expected publication');
            }
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: attemptKey,
                value: JSON.stringify({ ...active, status: 'cancelled' }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            await expect(storage.sql.begin(async (transaction) => {
                await transaction`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
                    values ('test:game', 'game-1', 'finished', now() + interval '1 day', now(), 0)`;
                await writeTournamentGame(transaction, computed.write);
            })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await runtime.findEntry('test:game', 'game-1')).toBeUndefined();
            const signals = await storage.sql<
                readonly { count: number; }[]
            >`select count(*)::integer as count from resource_inbox where ri_topic_id = 'app:rallar-tournaments:reconcile'`;
            expect(signals[0].count).toBe(0);
            expect(await runtime.findEntry(TOURNAMENT_RESULTS_NAMESPACE, key)).toBeUndefined();
            expect(computeTournamentResultPublication(await repository.read(binding), result, Date.now())).toEqual({
                kind: 'refused',
                reason: 'inactive-attempt'
            });
        }
        finally {
            await storage.close();
        }
    });

    it('allows only one writer that observed the same active attempt', async () => {
        const storage = await createResourceInboxTestStorage('tournament_result_overlap');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new TournamentResultRepository(runtime);
            const key = tournamentResultKey(binding);
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: attemptKey,
                value: JSON.stringify(active),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const read = await repository.read(binding);
            const first = computeTournamentResultPublication(read, result, Date.now());
            const second = computeTournamentResultPublication(read, result, Date.now());
            if (first.kind !== 'publish' || second.kind !== 'publish') {
                throw new Error('Expected publications');
            }
            await storage.sql.begin((transaction) => writeTournamentGame(transaction, first.write));
            await expect(storage.sql.begin((transaction) => writeTournamentGame(transaction, second.write)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await repository.read(binding)).result).toEqual(result);
        }
        finally {
            await storage.close();
        }
    });

    it.each([
        { ...active, binding: { ...binding, attemptId: 'old' } },
        { ...active, status: 'finished' },
        { ...active, startedAtEpochMs: null },
        { ...active, status: 'scheduled' }
    ])('fails closed on corrupt attempt state: %j', async (attempt) => {
        const storage = await createResourceInboxTestStorage('tournament_result_integrity');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: attemptKey,
                value: JSON.stringify(attempt),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            await expect(new TournamentResultRepository(runtime).read(binding)).rejects.toThrow();
        }
        finally {
            await storage.close();
        }
    });

    it.each([NEVER_EXPIRE_AT_TIMESTAMP, 1])('preserves an intervening result even when it expires at %s', async (expiry) => {
        const storage = await createResourceInboxTestStorage('tournament_result_absence');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new TournamentResultRepository(runtime);
            const key = tournamentResultKey(binding);
            await runtime.upsert({
                namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                key: attemptKey,
                value: JSON.stringify(active),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const read = await repository.read(binding);
            const computed = computeTournamentResultPublication(read, result, Date.now());
            if (computed.kind !== 'publish') {
                throw new Error('Expected publication');
            }
            await runtime.upsert({ namespace: TOURNAMENT_RESULTS_NAMESPACE, key, value: 'intervening result', expireAtTimestamp: expiry });
            await expect(storage.sql.begin((transaction) => writeTournamentGame(transaction, computed.write)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await runtime.findEntry(TOURNAMENT_ATTEMPTS_NAMESPACE, attemptKey))?.revision).toBe(read.attemptEntry?.revision);
            expect((await runtime.findEntry(TOURNAMENT_RESULTS_NAMESPACE, key))?.value).toBe('intervening result');
            await expect(repository.read(binding)).rejects.toThrow();
        }
        finally {
            await storage.close();
        }
    });

    it('refuses absent and unstarted attempts and a substituted start instant', async () => {
        const storage = await createResourceInboxTestStorage('tournament_result_start');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new TournamentResultRepository(runtime);
            expect(computeTournamentResultPublication(await repository.read(binding), result, Date.now())).toEqual({
                kind: 'refused',
                reason: 'inactive-attempt'
            });
            await runtime.upsert(
                {
                    namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                    key: attemptKey,
                    value: JSON.stringify({ ...active, status: 'scheduled', startedAtEpochMs: null }),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                }
            );
            expect(computeTournamentResultPublication(await repository.read(binding), result, Date.now())).toEqual({
                kind: 'refused',
                reason: 'inactive-attempt'
            });
            await runtime.upsert(
                {
                    namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                    key: attemptKey,
                    value: JSON.stringify({ ...active, startedAtEpochMs: 2000 }),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                }
            );
            const changedStart = await repository.read(binding);
            expect(() => computeTournamentResultPublication(changedStart, result, Date.now())).toThrow(/start/);
        }
        finally {
            await storage.close();
        }
    });
});
