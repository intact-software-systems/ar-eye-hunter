import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { GroupMoveRepository } from '@shared-server/rallar-system/group-state/move/group-move-repository.ts';
import { GroupMoveService } from '@shared-server/rallar-system/group-state/move/group-move-service.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { GroupMoveAction } from '@shared/api/mutation/group-move.ts';

import { createTestAuthSession } from '../group-state-test-runtime.ts';
import { createGroupMoveTestDatabase, DESTINATION } from './group-move-test-database.ts';

const TARGET = { ...DESTINATION, groupId: 'target' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0)) {
        await close();
    }
});

async function database() {
    const fixture = await createGroupMoveTestDatabase();
    cleanups.push(fixture.storage.close);
    await seedMoveRooms(fixture);
    let nowEpochMs = fixture.nowEpochMs;
    const moves = new GroupMoveRepository(fixture.runtime, () => nowEpochMs);
    const service = new GroupMoveService({
        groups: fixture.repository,
        moves,
        authSessions: new AuthSessionPersistence(fixture.runtime),
        mutations: fixture.service
    }, { serviceId: 'move-service-test', finishedRetentionMs: 86_400_000, now: () => nowEpochMs });
    async function prepare(action: GroupMoveAction, principalId = 'alice') {
        const session = createTestAuthSession(principalId);
        const command = service.authorize({
            requestId: `${action}-${principalId}`,
            moveId: 'move-1',
            source: DESTINATION,
            destination: TARGET,
            action,
            joinCode: null,
            inviteToken: null
        }, session);
        const ingress = await service.capture(command, session);
        const read = await service.read(ingress, { attemptCount: 1, traceId: 'move-test' });
        const computed = service.compute(read);
        expect(service.validate(read, computed)).toEqual([]);
        return computed.fold((rejection) => {
            throw new Error(rejection.message);
        }, (value) => value);
    }
    async function act(action: GroupMoveAction, principalId = 'alice') {
        const computed = await prepare(action, principalId);
        await fixture.storage.sql.begin((transaction) => service.write(transaction, computed));
        return computed.result;
    }
    async function ready() {
        await act('propose');
        await act('confirm');
        await act('confirm', 'bob');
    }
    return {
        ...fixture,
        moves,
        moveService: service,
        act,
        prepareMove: prepare,
        ready,
        advance: (duration: number) => {
            nowEpochMs += duration;
        }
    };
}

async function seedMoveRooms(fixture: Awaited<ReturnType<typeof createGroupMoveTestDatabase>>): Promise<void> {
    const bob = computeGroupMutation(await fixture.join('bob'));
    if (bob.outcome !== 'write') {
        throw new Error('Expected Bob to join source');
    }
    await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, bob));
    await connectSourcePlayers(fixture);
    const target = await fixture.prepare(
        mutationDescriptor({
            operation: 'createGroup',
            scope: TARGET,
            groupId: TARGET.groupId,
            request: {
                requestId: 'create-target',
                groupId: TARGET.groupId,
                displayName: 'Target',
                kind: 'room',
                joinMode: 'open',
                maxMembers: 3,
                createdByPrincipalId: 'carol'
            }
        }),
        'carol'
    );
    const created = computeGroupMutation(target);
    if (created.outcome !== 'write') {
        throw new Error('Expected target');
    }
    await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, created));
}

async function connectSourcePlayers(fixture: Awaited<ReturnType<typeof createGroupMoveTestDatabase>>): Promise<void> {
    for (const principalId of ['alice', 'bob']) {
        const prepared = await fixture.prepare(
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
        const connected = computeGroupMutation(prepared);
        if (connected.outcome !== 'write') {
            throw new Error('Expected connected source presence');
        }
        await fixture.storage.sql.begin((transaction) => writeGroupMutation(transaction, connected));
    }
}

describe('group move service', () => {
    it('stores scoped participant wakeups and a durable proposal deadline in the same transaction', async () => {
        const fixture = await database();
        const computed = await fixture.prepareMove('propose');
        const messages = computed.outbox.map((write) => JSON.parse(write.entry.resource));
        expect(messages.filter((message) => message.payload.typeId === 'group-move.changed').map((message) => message.targets.principalRef.principalId).sort())
            .toEqual(['alice', 'bob']);
        const deadline = computed.outbox.find((write) => JSON.parse(write.entry.resource).payload.typeId === 'GROUP_MOVE_DEADLINE');
        expect(deadline?.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(computed.result.expiresAtEpochMs);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, computed));
        const rows = await fixture.storage.sql<
            { count: string; }[]
        >`select count(*)::text as count from resource_inbox where ri_topic_id = 'group-move.changed'`;
        expect(Number(rows[0].count)).toBe(2);
    });

    it('expires durably without requiring any participant to send another request', async () => {
        const fixture = await database();
        const move = await fixture.act('propose');
        fixture.advance(120_000);
        const read = await fixture.moveService.readExpiry({ source: move.source, moveId: move.moveId, expiresAtEpochMs: move.expiresAtEpochMs }, 'expiry-test');
        const computed = fixture.moveService.computeExpiry(read);
        expect(fixture.moveService.validateExpiry(read, computed)).toEqual([]);
        await fixture.storage.sql.begin((transaction) => fixture.moveService.writeExpiry(transaction, computed));
        expect((await fixture.moves.listForPrincipal(DESTINATION, 'bob'))[0].status).toBe('expired');
    });

    it('rejects a stale expiry write after cancellation and replays the terminal outcome on retry', async () => {
        const fixture = await database();
        const move = await fixture.act('propose');
        fixture.advance(120000);
        const deadline = { source: move.source, moveId: move.moveId, expiresAtEpochMs: move.expiresAtEpochMs };
        const staleRead = await fixture.moveService.readExpiry(deadline, 'expiry-race');
        const stale = fixture.moveService.computeExpiry(staleRead);
        fixture.advance(-120000);
        await fixture.act('cancel');
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.writeExpiry(transaction, stale)))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        fixture.advance(120000);
        const retryRead = await fixture.moveService.readExpiry(deadline, 'expiry-retry');
        const retry = fixture.moveService.computeExpiry(retryRead);
        expect(retry).toMatchObject({ result: { status: 'cancelled' }, mutation: null });
    });

    it('requires both confirmations and commits both destination admissions with one outcome', async () => {
        const fixture = await database();
        await fixture.act('propose');
        await fixture.act('confirm');
        await expect(fixture.act('commit')).rejects.toThrow(/Every player/);
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
        await fixture.act('confirm', 'bob');
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
        const result = await fixture.act('commit');
        expect(result.status).toBe('committed');
        expect((await fixture.repository.readSnapshot(TARGET))?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob', 'carol']);
        expect((await fixture.repository.readSnapshot(DESTINATION))?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
        expect(await fixture.moves.listForPrincipal(DESTINATION, 'bob')).toEqual([result]);
    });

    it('rejects a stale commit after Bob revokes his confirmation', async () => {
        const fixture = await database();
        await fixture.ready();
        const commit = await fixture.prepareMove('commit');
        await fixture.act('withdraw', 'bob');
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, commit))).rejects.toThrow(
            RuntimeStateWriteConflictError
        );
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });

    it('rejects an already-computed commit when a participant session is revoked', async () => {
        const fixture = await database();
        await fixture.ready();
        const commit = await fixture.prepareMove('commit');
        await fixture.auth.deleteSession(createTestAuthSession('bob'));
        await expect(fixture.storage.sql.begin((transaction) => fixture.moveService.write(transaction, commit))).rejects.toThrow(
            RuntimeStateWriteConflictError
        );
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });

    it('expires instead of committing after the two-minute deadline', async () => {
        const fixture = await database();
        await fixture.ready();
        fixture.advance(120_000);
        expect((await fixture.act('commit')).status).toBe('expired');
        expect((await fixture.repository.readSnapshot(TARGET))?.memberCount).toBe(1);
    });
});
