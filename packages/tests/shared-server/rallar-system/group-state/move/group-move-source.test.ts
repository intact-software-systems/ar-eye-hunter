import { afterEach, describe, expect, it } from 'vitest';

import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { computeGroupMoveSource } from '@shared-server/rallar-system/group-state/move/compute-group-move-source.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { writeRuntimeStateGuardedBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-guarded-batch.ts';

import { createGroupMoveTestDatabase, DESTINATION } from './group-move-test-database.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0)) {
        await close();
    }
});

async function database() {
    const fixture = await createGroupMoveTestDatabase();
    cleanups.push(fixture.storage.close);
    const bob = computeGroupMutation(await fixture.join('bob'));
    if (bob.outcome !== 'write') {
        throw new Error('Expected Bob to join');
    }
    await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, bob));
    async function connect(principalId: string) {
        const command = await fixture.prepare(
            mutationDescriptor({
                operation: 'connectPresence',
                scope: DESTINATION,
                groupId: DESTINATION.groupId,
                sessionId: `${principalId}-session`,
                request: {
                    requestId: `connect-${principalId}`,
                    actorPrincipalId: principalId,
                    principalId,
                    generationId: `${principalId}-generation`,
                    connectionGenerationId: `${principalId}-connection`,
                    connectedAtEpochMs: fixture.nowEpochMs,
                    lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                    expiresAtEpochMs: fixture.nowEpochMs + 60_000
                }
            }),
            principalId
        );
        const result = computeGroupMutation(command);
        if (result.outcome !== 'write') {
            throw new Error('Expected a connected session');
        }
        await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, result));
    }
    async function readSource() {
        return computeGroupMoveSource(await fixture.repository.readPresenceSummaryEntries(DESTINATION), fixture.nowEpochMs);
    }
    return { ...fixture, connect, readSource };
}

describe('group move source authority', () => {
    it('selects authoritative present players before the asynchronous summary catches up', async () => {
        const fixture = await database();
        await fixture.connect('alice');
        const source = await fixture.readSource();
        expect(source?.snapshot.activeSessions.map((session) => session.sessionId)).toEqual(['alice-session']);
        expect(source?.snapshot.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
    });

    it('fences an offline member connecting after the roster read', async () => {
        const fixture = await database();
        await fixture.connect('alice');
        const source = await fixture.readSource();
        if (!source) {
            throw new Error('Expected the source room');
        }
        await fixture.connect('bob');
        const result = await fixture.storage.sql.begin((transaction) =>
            writeRuntimeStateGuardedBatch(transaction, computeRuntimeStateGuardedBatchWrite(source.guard))
        );
        expect(result.effects.some((effect) => effect.status === 'conflict')).toBe(true);
    });

    it('fences a membership change even when none of the selected sessions changes', async () => {
        const fixture = await database();
        await fixture.connect('alice');
        const source = await fixture.readSource();
        if (!source) {
            throw new Error('Expected the source room');
        }
        const carol = computeGroupMutation(await fixture.join('carol'));
        if (carol.outcome !== 'write') {
            throw new Error('Expected Carol to join');
        }
        await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, carol));
        const result = await fixture.storage.sql.begin((transaction) =>
            writeRuntimeStateGuardedBatch(transaction, computeRuntimeStateGuardedBatchWrite(source.guard))
        );
        expect(result.guard.status).toBe('conflict');
    });

    it('guards the unchanged roster without changing its domain values', async () => {
        const fixture = await database();
        await fixture.connect('alice');
        const source = await fixture.readSource();
        if (!source) {
            throw new Error('Expected the source room');
        }
        const result = await fixture.storage.sql.begin((transaction) =>
            writeRuntimeStateGuardedBatch(transaction, computeRuntimeStateGuardedBatchWrite(source.guard))
        );
        expect(result.guard.status).toBe('applied');
        expect(result.effects.every((effect) => effect.status === 'applied')).toBe(true);
        expect((await fixture.readSource())?.snapshot).toEqual(source.snapshot);
    });
});
