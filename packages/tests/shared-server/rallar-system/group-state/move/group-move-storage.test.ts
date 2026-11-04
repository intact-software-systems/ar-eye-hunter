import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { GroupMoveRecord } from '@shared-server/rallar-system/group-state/move/group-move-codec.ts';
import { computeGroupMoveStorage, GroupMoveRepository, writeGroupMoveStorage } from '@shared-server/rallar-system/group-state/move/group-move-repository.ts';
import type { RuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createGroupMoveTestDatabase, DESTINATION, type GroupMoveTestDatabase } from './group-move-test-database.ts';

async function writeOrRollback(transaction: PSqlSql, write: RuntimeStateGuardedBatchWrite): Promise<void> {
    if (await writeGroupMoveStorage(transaction, write) === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0)) {
        await close();
    }
});

function proposal(nowEpochMs: number, moveId = 'move-1', principalId = 'alice'): GroupMoveRecord {
    return {
        move: {
            moveId,
            source: { ...DESTINATION, groupId: 'source' },
            destination: DESTINATION,
            organizerSessionId: `${principalId}-session`,
            participants: [{
                principalId,
                sessionId: `${principalId}-session`,
                generationId: `${principalId}-generation`,
                generationVersion: nowEpochMs,
                confirmedAtEpochMs: null,
                arrivedAtEpochMs: null
            }],
            createdAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 120_000,
            completedAtEpochMs: null,
            status: 'proposed',
            reason: null,
            admissionFailure: null
        },
        credentials: []
    };
}

interface GroupMoveStorageFixture extends GroupMoveTestDatabase {
    readonly moves: GroupMoveRepository;
    prepareMove(record: GroupMoveRecord): Promise<RuntimeStateGuardedBatchWrite>;
    save(record: GroupMoveRecord): Promise<void>;
}

async function database(): Promise<GroupMoveStorageFixture> {
    const fixture = await createGroupMoveTestDatabase();
    cleanups.push(fixture.storage.close);
    const moves = new GroupMoveRepository(fixture.runtime, () => fixture.nowEpochMs);
    async function prepareMove(record: GroupMoveRecord): Promise<RuntimeStateGuardedBatchWrite> {
        const read = await moves.read(record.move);
        return computeGroupMoveStorage({ read, record, terminalRetentionMs: 86_400_000 }).fold((rejection) => {
            throw new Error(rejection.message);
        }, (write) => write);
    }
    async function save(record: GroupMoveRecord): Promise<void> {
        const write = await prepareMove(record);
        await fixture.storage.sql.begin((transaction) => writeOrRollback(transaction, write));
    }
    return { ...fixture, moves, prepareMove, save };
}

describe('durable group move claims and recovery', () => {
    it('finds a pending decision by participant without a remembered move id', async () => {
        const fixture = await database();
        const record = proposal(fixture.nowEpochMs);
        await fixture.save(record);
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'alice')).toEqual([record.move]);
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'bob')).toEqual([]);
    });

    it('allows only one concurrently proposed move in a source room', async () => {
        const fixture = await database();
        const first = proposal(fixture.nowEpochMs);
        const second = proposal(fixture.nowEpochMs, 'move-2');
        const pending = await fixture.prepareMove(second);
        await fixture.save(first);
        await expect(fixture.storage.sql.begin((transaction) => writeOrRollback(transaction, pending))).rejects.toThrow(RuntimeStateWriteConflictError);
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'alice')).toEqual([first.move]);
        expect((await fixture.moves.read(second.move)).record).toBeNull();
    });

    it('prevents the same participant entering two pending moves across source rooms', async () => {
        const fixture = await database();
        const first = proposal(fixture.nowEpochMs);
        const second = proposal(fixture.nowEpochMs, 'move-2');
        const otherSource = { ...second, move: { ...second.move, source: { ...second.move.source, groupId: 'another-source' } } };
        const pending = await fixture.prepareMove(otherSource);
        await fixture.save(first);
        await expect(fixture.storage.sql.begin((transaction) => writeOrRollback(transaction, pending))).rejects.toThrow(RuntimeStateWriteConflictError);
        expect((await fixture.moves.read(otherSource.move)).record).toBeNull();
    });

    it('releases live claims atomically on cancellation while retaining participant recovery', async () => {
        const fixture = await database();
        const first = proposal(fixture.nowEpochMs);
        await fixture.save(first);
        const cancelled: GroupMoveRecord = {
            ...first,
            move: { ...first.move, status: 'cancelled', reason: 'organizer-cancelled', completedAtEpochMs: fixture.nowEpochMs + 1 }
        };
        await fixture.save(cancelled);
        const second = proposal(fixture.nowEpochMs + 2, 'move-2');
        await fixture.save(second);
        expect((await fixture.moves.listForPrincipal(DESTINATION, 'alice')).map((move) => move.status).sort()).toEqual(['cancelled', 'proposed']);
    });

    it('rolls back outcome and claim release together after a later write fails', async () => {
        const fixture = await database();
        const first = proposal(fixture.nowEpochMs);
        await fixture.save(first);
        const cancelled: GroupMoveRecord = {
            ...first,
            move: { ...first.move, status: 'cancelled', reason: 'organizer-cancelled', completedAtEpochMs: fixture.nowEpochMs + 1 }
        };
        const write = await fixture.prepareMove(cancelled);
        await expect(fixture.storage.sql.begin(async (transaction) => {
            await writeOrRollback(transaction, write);
            throw new Error('Result publication failed');
        })).rejects.toThrow('Result publication failed');
        expect((await fixture.moves.read(first.move)).record?.value).toEqual(first);
        await expect(fixture.prepareMove(proposal(fixture.nowEpochMs + 2, 'move-2'))).rejects.toThrow(/pending/i);
    });

    it('fails closed when a pending move has lost one of its claims', async () => {
        const fixture = await database();
        const record = proposal(fixture.nowEpochMs);
        await fixture.save(record);
        const read = await fixture.moves.read(record.move);
        const claim = read.claims.find((claim) => claim.kind === 'participant');
        if (!claim) {
            throw new Error('Expected participant claim');
        }
        await fixture.runtime.deleteByKey(claim.namespace, claim.key);
        await expect(fixture.prepareMove(record)).rejects.toThrow(/claim/i);
    });

    it('rejects a valid same-scope claim copied into another principal slot', async () => {
        const fixture = await database();
        const record = proposal(fixture.nowEpochMs);
        await fixture.save(record);
        const read = await fixture.moves.read(record.move);
        const claim = read.claims.find((entry) => entry.kind === 'participant');
        if (!claim?.current) {
            throw new Error('Expected stored participant claim');
        }
        const other = { ...record.move, participants: record.move.participants.map((participant) => ({ ...participant, principalId: 'bob' })) };
        const bobClaim = (await fixture.moves.read(other)).claims.find((entry) => entry.kind === 'participant');
        if (!bobClaim) {
            throw new Error('Expected Bob claim selector');
        }
        await fixture.runtime.upsert({
            namespace: bobClaim.namespace,
            key: bobClaim.key,
            value: claim.current.entry.value,
            expireAtTimestamp: claim.current.entry.expireAtTimestamp
        });
        await expect(fixture.moves.read(other)).rejects.toThrow(/identity|principal/i);
    });

    it('rejects a stale terminal write after physical record deletion and same-claim revision reuse', async () => {
        const fixture = await database();
        const original = proposal(fixture.nowEpochMs);
        await fixture.save(original);
        const terminal: GroupMoveRecord = {
            ...original,
            move: { ...original.move, completedAtEpochMs: fixture.nowEpochMs + 1, status: 'cancelled', reason: 'organizer-cancelled' }
        };
        await fixture.save(terminal);
        const captured = await fixture.prepareMove(terminal);
        const previous = (await fixture.moves.read(original.move)).record!.entry;
        const replacement = proposal(previous.expireAtTimestamp + 1, original.move.moveId, 'bob');
        await fixture.storage.sql`delete from runtime_state_store where store_namespace='group_moves' and store_key=${previous.key}`;
        for (let revision = 0; revision <= previous.revision; revision++) {
            await fixture.runtime.upsert({
                namespace: 'group_moves',
                key: previous.key,
                value: JSON.stringify(replacement),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
        }
        expect((await fixture.moves.find(replacement.move))!.entry.revision).toBe(previous.revision);
        await expect(fixture.storage.sql.begin((transaction) => writeOrRollback(transaction, captured))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await fixture.moves.find(replacement.move))!.value).toEqual(replacement);
    });

    it('omits an old participant lookup when retention passes and its claim is reused by another cohort during the read', async () => {
        const fixture = await database();
        const original = proposal(fixture.nowEpochMs);
        await fixture.save(original);
        const terminal: GroupMoveRecord = {
            ...original,
            move: { ...original.move, completedAtEpochMs: fixture.nowEpochMs + 1, status: 'cancelled', reason: 'organizer-cancelled' }
        };
        await fixture.save(terminal);
        let now = fixture.nowEpochMs;
        const reader = new GroupMoveRepository(fixture.runtime, () => now);
        const previous = (await reader.find(original.move))!.entry;
        const replacement = proposal(previous.expireAtTimestamp + 1, original.move.moveId, 'bob');
        const find = reader.find.bind(reader);
        vi.spyOn(reader, 'find').mockImplementationOnce(async (claim) => {
            now = replacement.move.createdAtEpochMs;
            await fixture.runtime.upsert({
                namespace: 'group_moves',
                key: previous.key,
                value: JSON.stringify(replacement),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            return await find(claim);
        });
        expect(await reader.listForPrincipal(DESTINATION, 'alice')).toEqual([]);
        expect((await reader.find(replacement.move))!.value).toEqual(replacement);
    });

    it('requires the full selected claim set before preparing a write', async () => {
        const fixture = await database();
        const record = proposal(fixture.nowEpochMs);
        const read = await fixture.moves.read(record.move);
        expect(() =>
            computeGroupMoveStorage({
                read: { ...read, claims: read.claims.filter((claim) => claim.kind !== 'participant') },
                record,
                terminalRetentionMs: 86_400_000
            })
        ).toThrow(/claim/i);
    });

    it('rejects a decision stored under a different scoped identity', async () => {
        const fixture = await database();
        const first = proposal(fixture.nowEpochMs);
        await fixture.save(first);
        const stored = (await fixture.moves.read(first.move)).record;
        if (!stored) {
            throw new Error('Expected the stored move');
        }
        const namespace = 'group_moves';
        await fixture.runtime.upsert(
            {
                namespace,
                key: stored.entry.key,
                value: JSON.stringify({ ...first, move: { ...first.move, moveId: 'different' } }),
                expireAtTimestamp: stored.entry.expireAtTimestamp
            }
        );
        await expect(fixture.moves.read(first.move)).rejects.toThrow(/identity/i);
    });
});
