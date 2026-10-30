import { afterEach, describe, expect, it } from 'vitest';

import type { GroupMoveRecord } from '@shared-server/rallar-system/group-state/move/group-move-codec.ts';
import { computeGroupMoveStorage, GroupMoveRepository, writeGroupMoveStorage } from '@shared-server/rallar-system/group-state/move/group-move-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import { createGroupMoveTestDatabase, DESTINATION } from './group-move-test-database.ts';

async function writeOrRollback(...args: Parameters<typeof writeGroupMoveStorage>): Promise<void> {
    if (await writeGroupMoveStorage(...args) === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0)) {
        await close();
    }
});

function proposal(nowEpochMs: number, moveId = 'move-1'): GroupMoveRecord {
    return {
        move: {
            moveId,
            source: { ...DESTINATION, groupId: 'source' },
            destination: DESTINATION,
            organizerSessionId: 'alice-session',
            participants: [{
                principalId: 'alice',
                sessionId: 'alice-session',
                generationId: 'alice-generation',
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

async function database() {
    const fixture = await createGroupMoveTestDatabase();
    cleanups.push(fixture.storage.close);
    const moves = new GroupMoveRepository(fixture.runtime, () => fixture.nowEpochMs);
    async function prepare(record: GroupMoveRecord) {
        const read = await moves.read(record.move);
        return computeGroupMoveStorage({ read, record, terminalRetentionMs: 86_400_000 }).fold((rejection) => {
            throw new Error(rejection.message);
        }, (write) => write);
    }
    async function save(record: GroupMoveRecord) {
        const write = await prepare(record);
        await fixture.storage.sql.begin((transaction) => writeOrRollback(transaction, write));
    }
    return { ...fixture, moves, prepare, save };
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
        const pending = await fixture.prepare(second);
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
        const pending = await fixture.prepare(otherSource);
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
        const write = await fixture.prepare(cancelled);
        await expect(fixture.storage.sql.begin(async (transaction) => {
            await writeOrRollback(transaction, write);
            throw new Error('Result publication failed');
        })).rejects.toThrow('Result publication failed');
        expect((await fixture.moves.read(first.move)).record?.value).toEqual(first);
        await expect(fixture.prepare(proposal(fixture.nowEpochMs + 2, 'move-2'))).rejects.toThrow(/pending/i);
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
        await expect(fixture.prepare(record)).rejects.toThrow(/claim/i);
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
        await fixture.runtime.upsert(bobClaim.namespace, bobClaim.key, claim.current.entry.value, claim.current.entry.expireAtTimestamp);
        await expect(fixture.moves.read(other)).rejects.toThrow(/identity|principal/i);
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
            namespace,
            stored.entry.key,
            JSON.stringify({ ...first, move: { ...first.move, moveId: 'different' } }),
            stored.entry.expireAtTimestamp
        );
        await expect(fixture.moves.read(first.move)).rejects.toThrow(/identity/i);
    });
});
