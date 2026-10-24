import { createRelicGame } from '@relic-hunters/mod.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createGameFixture, prepareGameWrite } from './relic-game-database-fixture.ts';
import { createInboxFixture } from './relic-game-inbox-fixture.ts';

describe('Relic room retirement and save authority', () => {
    it.each(['save-first', 'archive-first'] as const)('converges without resurrecting a save when %s wins', async (winner) => {
        const fixture = await createGameFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const game = await prepareGameWrite(fixture, fixture.command, initial);
            const retirement = retentionOwner(fixture);
            // No live sessions: retention first records the observed empty period, then archives at its deadline.
            await reconcile(fixture, retirement, 'observe-empty');
            const freshGame = await prepareGameWrite(fixture, fixture.command, initial);
            fixture.nowEpochMs += 600_000;
            const ingress = retirement.capture({ groupRef: fixture.ref, requestId: 'archive', observedAtEpochMs: fixture.nowEpochMs });
            const archiveRead = await retirement.read(ingress, 1);
            const archive = retirement.compute(archiveRead);
            expect(retirement.validate(archiveRead, archive)).toEqual([]);
            expect(archive).toMatchObject({ outcome: 'write', group: { status: 'archived' } });
            if (winner === 'save-first') {
                await fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, freshGame.computed));
                await expect(fixture.storage.sql.begin((transaction) => retirement.write(transaction, archive)))
                    .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
                const retryRead = await retirement.read(ingress, 2);
                const retry = retirement.compute(retryRead);
                expect(retirement.validate(retryRead, retry)).toEqual([]);
                await fixture.storage.sql.begin((transaction) => retirement.write(transaction, retry));
            }
            else {
                await fixture.storage.sql.begin((transaction) => retirement.write(transaction, archive));
                await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, freshGame.computed)))
                    .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            }
            fixture.nowEpochMs += 604_800_000;
            await reconcile(fixture, retirement, 'delete');
            expect(await fixture.repository.findGroup(fixture.ref)).toBeUndefined();
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
            await expect(fixture.storage.sql.begin((transaction) => fixture.service.write(transaction, game.computed)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const current = fixture.service.compute(await fixture.service.read(game.ingress));
            expect(current.result).toMatchObject({ status: 'refused', code: 'room-unavailable' });
            expect(current.save).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);

    it('replays only an acknowledgement after reset or deletion and reads current authorized state', async () => {
        const fixture = await createInboxFixture();
        try {
            const initial = createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs);
            const first = await fixture.inbox.enqueue(fixture.command, async () => initial);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(first)).toEqual({ status: 'initialized', gameId: fixture.ref.groupId });
            const reset = await fixture.inbox.enqueue({ ...fixture.command, operation: 'reset', requestId: 'reset' }, async () => initial);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.inbox.wait(reset)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
            const replay = await fixture.inbox.enqueue(fixture.command, async () => {
                throw new Error('Replay must not generate a new expedition');
            });
            expect(await fixture.inbox.wait(replay)).toEqual({ status: 'initialized', gameId: fixture.ref.groupId });
            expect(await fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server'))
                .toMatchObject({ createdAtEpochMs: initial.createdAtEpochMs + 1 });
            const retirement = retentionOwner(fixture);
            const group = await fixture.repository.findGroupEntry(fixture.ref);
            if (!group) {
                throw new Error('Expected the initialized room');
            }
            // Backdate only the lifecycle fixture, preserving the live idempotency evidence's own retention.
            await fixture.repository.updateGroup({
                ...group.value,
                status: 'archived',
                deleted: null,
                archived: { ...group.value.updated, atEpochMs: fixture.nowEpochMs - 604_800_000 }
            }, group.entry.revision);
            await reconcile(fixture, retirement, 'delete-replayed-game');
            expect(await fixture.inbox.wait(await fixture.inbox.enqueue(fixture.command, async () => initial)))
                .toEqual({ status: 'initialized', gameId: fixture.ref.groupId });
            await expect(fixture.service.readCurrentSnapshot(fixture.command, 'default-qbox-server'))
                .rejects.toMatchObject({ result: { code: 'room-unavailable', httpStatus: 404 } });
            expect((await fixture.data.read(fixture.ref))[0].entry).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);
});

function retentionOwner(fixture: Awaited<ReturnType<typeof createGameFixture>>): GroupRetentionService {
    return new GroupRetentionService({ repository: fixture.repository, groupOwnedAppData: fixture.data }, {
        serviceId: 'relic-retention-test',
        now: () => fixture.nowEpochMs
    });
}

async function reconcile(
    fixture: Awaited<ReturnType<typeof createGameFixture>>,
    service: GroupRetentionService,
    requestId: string
): Promise<void> {
    const ingress = service.capture({ groupRef: fixture.ref, requestId, observedAtEpochMs: fixture.nowEpochMs });
    const read = await service.read(ingress, 1);
    const computed = service.compute(read);
    expect(service.validate(read, computed)).toEqual([]);
    await fixture.storage.sql.begin((transaction) => service.write(transaction, computed));
}
