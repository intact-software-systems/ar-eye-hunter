import { EMPTY_INPUT } from '@ar-eye-hunter/arena-player-state.ts';
import { decodeArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { installArenaTournamentClock } from '@ar-eye-hunter/server/arena-tournament-deadline.ts';
import { registerArenaTournamentInbox } from '@ar-eye-hunter/server/arena-tournament-inbox.ts';
import { ArenaTournamentMutation } from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import { AR_EYE_TOURNAMENT_RULES_ID } from '@ar-eye-hunter/tournament-arena.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { SESSIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStatePresenceSessionStorageKey } from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE, TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { createSqlServerAppInbox } from '../../shared-server/rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import {
    commitMutation,
    createRetentionDatabaseFixture,
    prepareMutation,
    requireMutationWrite,
    RETENTION_REF,
    seedRetentionRoom
} from '../../shared-server/rallar-system/group-state/retention/group-retention-database-fixture.ts';

interface ArenaQueueObservation {
    readonly ri_topic_id: string;
    readonly ri_status: string;
    readonly ri_attempts: number;
}

async function fixture() {
    const database = await createRetentionDatabaseFixture();
    await seedRetentionRoom(database);
    const member = await prepareMutation(
        database,
        mutationDescriptor({
            operation: 'upsertMember',
            scope: RETENTION_REF,
            groupId: RETENTION_REF.groupId,
            targetPrincipalId: 'bob',
            request: { requestId: 'join-bob', status: 'active', actorPrincipalId: 'owner' }
        })
    );
    await commitMutation(database, requireMutationWrite(member.computed));
    const binding: TournamentMatchBinding = {
        tournamentRef: { applicationId: RETENTION_REF.applicationId, workspaceId: RETENTION_REF.workspaceId, tournamentId: 'cup' },
        slot: 'semifinal-1',
        attemptId: 'attempt-1',
        roomRef: RETENTION_REF,
        gameId: 'game-1',
        rulesId: AR_EYE_TOURNAMENT_RULES_ID,
        principalIds: ['owner', 'bob']
    };
    const attempt = { binding, status: 'playing', startedAtEpochMs: database.nowEpochMs };
    await database.runtime.upsert({
        namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
        key: groupStateGroupStorageKey(RETENTION_REF),
        value: JSON.stringify(attempt),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    });
    const dataBinding = {
        applicationId: RETENTION_REF.applicationId,
        workspaceId: RETENTION_REF.workspaceId,
        namespace: 'app:ar-eye',
        storeName: 'tournament-arenas'
    };
    const data = new RoomOwnedAppData(new PSqlAppDataRepository(database.storage.sql), [dataBinding]);
    const sessions = new AuthSessionPersistence(database.runtime);
    const results = new TournamentResultRepository(database.runtime);
    const service = new ArenaTournamentMutation({ groups: database.repository, sessions, results, data }, {
        nowEpochMs: () => database.nowEpochMs,
        serverId: 'ar-eye-owner'
    });
    return Object.assign(database, { binding, attempt, service, results, sessions, data, dataBinding });
}

function tick(requestId: string): ArenaTournamentMutation.Command {
    return { kind: 'tick', roomRef: RETENTION_REF, requestId, actor: null, input: null, capturedAtEpochMs: 0 };
}

async function commit(game: Awaited<ReturnType<typeof fixture>>, command: ArenaTournamentMutation.Command) {
    const read = await game.service.read(command, 'arena-test');
    const computed = game.service.compute(read);
    expect(game.service.validate(read, computed)).toEqual([]);
    await game.storage.sql.begin((transaction) => game.service.write(transaction, computed));
    return computed.result;
}

async function connectOwner(game: Awaited<ReturnType<typeof fixture>>) {
    const connected = await prepareMutation(
        game,
        mutationDescriptor({
            operation: 'connectPresence',
            scope: RETENTION_REF,
            groupId: RETENTION_REF.groupId,
            sessionId: game.owner.sessionId,
            request: {
                requestId: 'connect-owner',
                principalId: game.owner.clientId,
                generationId: 'generation-owner',
                connectionGenerationId: 'connection-owner',
                publicationKey: null,
                connectedAtEpochMs: game.nowEpochMs,
                lastHeartbeatAtEpochMs: game.nowEpochMs,
                expiresAtEpochMs: game.nowEpochMs + 60000,
                actorPrincipalId: game.owner.clientId
            }
        })
    );
    await commitMutation(game, requireMutationWrite(connected.computed));
    return {
        kind: 'input',
        roomRef: RETENTION_REF,
        requestId: 'owner-input',
        capturedAtEpochMs: 0,
        actor: { principalId: game.owner.clientId, sessionId: game.owner.sessionId, issuedAtEpochMs: game.owner.issuedAtEpochMs },
        input: { sequence: 1, yaw: 0, pitch: 0, controls: { ...EMPTY_INPUT, moveX: 1 } }
    } satisfies ArenaTournamentMutation.Command;
}

describe('AR Eye tournament mutation authority', () => {
    it('serves the native tournament checkpoint only to current readable room members', async () => {
        const game = await fixture();
        try {
            const input = await connectOwner(game);
            await commit(game, input);
            const snapshot = await game.service.readSnapshot(RETENTION_REF, 'owner');
            expect(snapshot?.binding).toEqual(game.binding);
            expect(decodeArenaTournamentSnapshot(snapshot)).toEqual(snapshot);
            expect(snapshot?.state?.gameId).toBe(game.binding.gameId);
            expect(JSON.stringify(snapshot)).not.toContain(input.actor?.sessionId);
            await expect(game.service.readSnapshot(RETENTION_REF, 'outsider')).rejects.toMatchObject({ status: 403 });
        }
        finally {
            await game.storage.close();
        }
    });

    it('deletes its room-owned arena on retirement and fences a previously computed game write', async () => {
        const game = await fixture();
        try {
            await commit(game, tick('initialize-before-retirement'));
            expect((await game.data.read(RETENTION_REF))[0].entry).toMatchObject({
                key: RETENTION_REF.groupId,
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const staleRead = await game.service.read(tick('stale-tick'), 'arena-retirement');
            const stale = game.service.compute(staleRead);
            const group = await game.repository.findGroupEntry(RETENTION_REF);
            if (!group) {
                throw new Error('Expected tournament room');
            }
            await game.repository.updateGroup({
                ...group.value,
                status: 'archived',
                deleted: null,
                archived: { ...group.value.updated, atEpochMs: game.nowEpochMs - 604800000 }
            }, group.entry.revision);
            const retirement = new GroupRetentionService({ runtime: game.runtime, repository: game.repository, groupOwnedAppData: game.data }, {
                finishedRetentionMs: 60000,
                serviceId: 'arena-retirement',
                now: () => game.nowEpochMs
            });
            const ingress = retirement.capture({ groupRef: RETENTION_REF, requestId: 'delete-arena', observedAtEpochMs: game.nowEpochMs });
            const read = await retirement.read(ingress, { attemptCount: 1, traceId: 'arena-retirement' });
            const computed = retirement.compute(read);
            expect(retirement.validate(read, computed)).toEqual([]);
            await game.storage.sql.begin((transaction) => retirement.write(transaction, computed));
            expect(await game.repository.findGroup(RETENTION_REF)).toBeUndefined();
            expect((await game.data.read(RETENTION_REF))[0].entry).toBeNull();
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, stale))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect((await commit(game, tick('after-retirement'))).reason).toBe('room-unavailable');
        }
        finally {
            await game.storage.close();
        }
    });

    it('creates only a privately authorized game and commits its actual final result with final state', async () => {
        const game = await fixture();
        try {
            expect((await commit(game, tick('start'))).status).toBe('applied');
            const initial = await game.service.read(tick('read'), 'arena-test');
            expect(initial.state?.gameId).toBe('game-1');
            game.nowEpochMs += 60000;
            for (let index = 0; index < 60; index++) {
                await commit(game, tick(`finish-${index}`));
            }
            const finished = await game.service.read(tick('finished'), 'arena-test');
            expect(finished.state?.arena.match?.status).toBe('complete');
            const result = (await game.results.read(game.binding)).result;
            expect(result?.standings.map((entry) => entry.rank)).toEqual([1, 1]);
            expect(result?.startedAtEpochMs).toBe(game.attempt.startedAtEpochMs);
            expect(result?.finishedAtEpochMs).toBe(game.attempt.startedAtEpochMs + 60000);
        }
        finally {
            await game.storage.close();
        }
    }, 15000);

    it('cancels a stale game write when the organizer invalidates the attempt after read', async () => {
        const game = await fixture();
        try {
            const read = await game.service.read(tick('racing-start'), 'arena-test');
            const computed = game.service.compute(read);
            await game.runtime.upsert(
                {
                    namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
                    key: groupStateGroupStorageKey(RETENTION_REF),
                    value: JSON.stringify({ ...game.attempt, status: 'cancelled' }),
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
                }
            );
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect(await game.service.readSnapshot(RETENTION_REF, 'owner')).toMatchObject({ status: 'cancelled', state: null });
            expect((await game.service.read(tick('after'), 'arena-test')).state).toBeNull();
            expect((await commit(game, tick('retry'))).status).toBe('refused');
        }
        finally {
            await game.storage.close();
        }
    });

    it('does not accept a client-selected score or unauthenticated actor', async () => {
        const game = await fixture();
        try {
            const command: ArenaTournamentMutation.Command = {
                kind: 'input',
                roomRef: RETENTION_REF,
                requestId: 'forged-actor',
                capturedAtEpochMs: 0,
                actor: { principalId: 'owner', sessionId: 'forged-session', issuedAtEpochMs: 1 },
                input: { sequence: 1, yaw: 0, pitch: 0, controls: EMPTY_INPUT }
            };
            expect((await commit(game, command)).status).toBe('refused');
            expect((await game.service.read(tick('missing'), 'arena-test')).state).toBeNull();
            const forged = {
                ...command,
                input: { sequence: 1, yaw: 0, pitch: 0, controls: EMPTY_INPUT, score: 9999 }
            };
            await expect(game.service.read(forged, 'arena-test')).rejects.toThrow();
        }
        finally {
            await game.storage.close();
        }
    });
    it('accepts controls from a present authenticated entrant and moves only through server time', async () => {
        const game = await fixture();
        try {
            const input = await connectOwner(game);
            expect((await commit(game, input)).status).toBe('applied');
            const before = (await game.service.read(tick('before'), 'arena-test')).state!;
            game.nowEpochMs += 100;
            await commit(game, tick('move'));
            const after = (await game.service.read(tick('after'), 'arena-test')).state!;
            expect(after.players[0].simulation.position).not.toEqual(before.players[0].simulation.position);
            expect(after.players[0].input.sequence).toBe(1);
            expect((await commit(game, input)).reason).toBe('stale-input');
        }
        finally {
            await game.storage.close();
        }
    });

    it.each(['authentication', 'presence'] as const)('rolls back input when %s is revoked after read', async (authority) => {
        const game = await fixture();
        try {
            const input = await connectOwner(game);
            const read = await game.service.read(input, 'arena-test');
            const computed = game.service.compute(read);
            expect(computed.result.status).toBe('applied');
            if (authority === 'authentication') {
                await game.sessions.deleteSession(game.owner);
            }
            else {
                await game.runtime.deleteByKey(SESSIONS_NAMESPACE, groupStatePresenceSessionStorageKey({ ...RETENTION_REF, sessionId: game.owner.sessionId }));
            }
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect((await game.service.read(tick('after-revocation'), 'arena-test')).state).toBeNull();
            expect((await commit(game, input)).status).toBe('refused');
        }
        finally {
            await game.storage.close();
        }
    });

    it('uses AppInbox for durable admission, exact replay and changed-command rejection', async () => {
        const game = await fixture();
        try {
            const runtime = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const operation = registerArenaTournamentInbox({ appInbox: runtime.inbox, mutations: game.service, nowEpochMs: () => game.nowEpochMs });
            runtime.inbox.start();
            const input = await connectOwner(game);
            const admitted = await operation.enqueue({ command: input, traceId: 'arena-input-test' });
            expect(admitted.left).toBeUndefined();
            expect((await game.service.read(tick('pending'), 'arena-test')).state).toBeNull();
            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const result = await admitted.right!.wait();
            expect(result.right?.status).toBe('applied');
            const before = await game.service.read(tick('before-replay'), 'arena-test');
            game.nowEpochMs += 500;
            const replay = await operation.submit({ command: input, traceId: 'arena-input-replay' });
            expect(replay.right).toEqual(result.right);
            const after = await game.service.read(tick('after-replay'), 'arena-test');
            expect(after.save).toEqual(before.save);
            const changed = await operation.enqueue({ command: { ...input, input: { ...input.input, sequence: 2 } }, traceId: 'arena-input-conflict' });
            expect(changed.left?.status).toBe(409);
        }
        finally {
            await game.storage.close();
        }
    });
    it('recovers the durable clock after restart when input already advanced its due step', async () => {
        const game = await fixture();
        try {
            const input = await connectOwner(game);
            await commit(game, input);
            const unrelatedBefore = await game.storage.sql<readonly ArenaQueueObservation[]>`select ri_topic_id, ri_status, ri_attempts from resource_inbox
                where ri_topic_id <> 'app:ar-eye:tournament-clock' order by ri_topic_id, ri_resource_id`;
            expect(unrelatedBefore.length).toBeGreaterThan(0);
            game.nowEpochMs += 50;
            await commit(game, { ...input, requestId: 'second-input', input: { ...input.input, sequence: 2 } });
            const runtime = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const operation = registerArenaTournamentInbox({ appInbox: runtime.inbox, mutations: game.service, nowEpochMs: () => game.nowEpochMs });
            installArenaTournamentClock({ outbox: runtime.outbox, operation, nowEpochMs: () => game.nowEpochMs });
            runtime.inbox.start();
            // Queue claims use PostgreSQL time; make only logically due clock rows claimable in this accelerated test.
            await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC'
                where ri_topic_id = 'app:ar-eye:tournament-clock' and next_ts <= ${new Date(game.nowEpochMs).toISOString()}::timestamp`;
            const otherWorker = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            otherWorker.outbox.onOutboxMessageDo('app:ar-eye:tournament-clock', {
                onMessage: async () => {
                    throw new Error('Another application claimed the arena clock');
                }
            }, ['app:other-game:clock']);
            expect(await otherWorker.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0))).toBe(0);
            await runtime.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const rows = await game.storage.sql<
                readonly { count: number; }[]
            >`select count(*)::integer as count from resource_inbox where ri_topic_id = 'app:ar-eye:tournament-clock'`;
            expect(rows[0].count).toBe(2);
            game.nowEpochMs += 60000;
            for (let index = 0; index < 61; index++) {
                // Queue claims use PostgreSQL time; make only logically due clock rows claimable in this accelerated test.
                await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC'
                where ri_topic_id = 'app:ar-eye:tournament-clock' and next_ts <= ${new Date(game.nowEpochMs).toISOString()}::timestamp`;
                await runtime.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                game.nowEpochMs += 1;
            }
            const finished = await game.service.read(tick('after-recovery'), 'arena-test');
            expect(finished.state?.arena.match?.status).toBe('complete');
            expect((await game.results.read(game.binding)).result).not.toBeNull();
            const unrelatedAfter = await game.storage.sql<readonly ArenaQueueObservation[]>`select ri_topic_id, ri_status, ri_attempts from resource_inbox
                where ri_topic_id <> 'app:ar-eye:tournament-clock' and ri_topic_id <> 'app:ar-eye:tournament' and ri_topic_id <> 'app:rallar-tournaments:reconcile' order by ri_topic_id, ri_resource_id`;
            expect(unrelatedAfter).toEqual(unrelatedBefore);
        }
        finally {
            await game.storage.close();
        }
    }, 30000);
});
