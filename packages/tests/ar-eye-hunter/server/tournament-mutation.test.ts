import { EMPTY_INPUT } from '@ar-eye-hunter/arena-player-state.ts';
import { decodeArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { ARENA_TOURNAMENT_FINISH_TOPIC, installArenaTournamentClock } from '@ar-eye-hunter/server/arena-tournament-deadline.ts';
import { registerArenaTournamentInbox } from '@ar-eye-hunter/server/arena-tournament-inbox.ts';
import { ArenaTournamentMutation } from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import { ArenaTournamentPublication, installArenaTournamentFinishPublication } from '@ar-eye-hunter/server/arena-tournament-publication.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { SESSIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStatePresenceSessionStorageKey } from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { createSqlServerAppInbox } from '../../shared-server/rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import {
    commitMutation,
    prepareMutation,
    requireMutationWrite,
    RETENTION_REF
} from '../../shared-server/rallar-system/group-state/retention/group-retention-database-fixture.ts';
import { commitArenaTournamentCommand, createArenaTournamentSqlFixture, type ArenaTournamentSqlFixture } from './arena-tournament-sql-fixture.ts';

interface ArenaQueueObservation {
    readonly ri_topic_id: string;
    readonly ri_status: string;
    readonly ri_attempts: number;
}

function tick(requestId: string): ArenaTournamentMutation.Command {
    return { kind: 'tick', roomRef: RETENTION_REF, requestId, actor: null, input: null, capturedAtEpochMs: 0 };
}

async function connectOwner(game: ArenaTournamentSqlFixture) {
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
        const game = await createArenaTournamentSqlFixture();
        try {
            const input = await connectOwner(game);
            await commitArenaTournamentCommand(game, input);
            const snapshot = await game.snapshots.readSnapshot(RETENTION_REF, 'owner');
            expect(snapshot?.binding).toEqual(game.binding);
            expect(snapshot?.attemptRevision).toBe((await game.results.read(game.binding)).attemptEntry?.revision);
            expect(decodeArenaTournamentSnapshot(snapshot)).toEqual(snapshot);
            expect(snapshot?.state?.gameId).toBe(game.binding.gameId);
            expect(JSON.stringify(snapshot)).not.toContain(input.actor?.sessionId);
            await expect(game.snapshots.readSnapshot(RETENTION_REF, 'outsider')).rejects.toMatchObject({ status: 403 });
        }
        finally {
            await game.storage.close();
        }
    });

    it.runIf(process.env.RALLAR_POSTGRES_INTEGRATION === '1')(
        'serves one committed attempt/checkpoint when a concurrent writer changes both during hydration',
        async () => {
            const game = await createArenaTournamentSqlFixture();
            try {
                await commitArenaTournamentCommand(game, tick('before-read'));
                const before = await game.snapshots.readSnapshot(RETENTION_REF, 'owner');
                game.nowEpochMs += 500;
                const next = game.service.compute(await game.service.read(tick('during-read'), 'arena-concurrency'));
                const locked = Promise.withResolvers<number>();
                const release = Promise.withResolvers<void>();
                const writer = game.storage.sql.begin(async (sql) => {
                    await sql`lock table app_data_store in access exclusive mode`;
                    const [backend] = await sql<{ pid: number; }[]>`select pg_backend_pid() as pid`;
                    locked.resolve(backend.pid);
                    await release.promise;
                    await game.service.write(sql, next);
                });
                void writer.catch(locked.reject);
                const pid = await locked.promise;
                const hydration = game.snapshots.readSnapshot(RETENTION_REF, 'owner');
                try {
                    await waitForBlockedHydration(game.storage.sql, pid);
                }
                finally {
                    release.resolve();
                    await writer;
                }
                const observed = await hydration;
                const after = await game.snapshots.readSnapshot(RETENTION_REF, 'owner');
                expect(observed).toMatchObject({ attemptRevision: before!.attemptRevision, state: before!.state });
                expect(after!.attemptRevision).toBe(before!.attemptRevision + 1);
                expect(after!.state!.simulatedAtEpochMs).toBeGreaterThan(before!.state!.simulatedAtEpochMs);
            }
            finally {
                await game.storage.close();
            }
        }
    );

    it('deletes its room-owned arena on retirement and fences a previously computed game write', async () => {
        const game = await createArenaTournamentSqlFixture();
        try {
            await commitArenaTournamentCommand(game, tick('initialize-before-retirement'));
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
            expect((await commitArenaTournamentCommand(game, tick('after-retirement'))).reason).toBe('room-unavailable');
        }
        finally {
            await game.storage.close();
        }
    });

    it('creates only a privately authorized game and commits its actual final result with final state', async () => {
        const game = await createArenaTournamentSqlFixture();
        try {
            expect((await commitArenaTournamentCommand(game, tick('start'))).status).toBe('applied');
            const initial = await game.service.read(tick('read'), 'arena-test');
            expect(initial.state?.gameId).toBe('game-1');
            game.nowEpochMs += 60000;
            for (let index = 0; index < 60; index++) {
                await commitArenaTournamentCommand(game, tick(`finish-${index}`));
            }
            const restart = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const terminalRevisions: number[] = [];
            const publisher = new ArenaTournamentPublication({
                timers: createDefaultBackgroundTimers(),
                read: (ref) => game.snapshots.readForPublication(ref),
                send: async (frame) => {
                    expect(frame.status).toBe('finished');
                    terminalRevisions.push(frame.attemptRevision);
                }
            });
            installArenaTournamentFinishPublication({ outbox: restart.outbox, publication: publisher, nowEpochMs: () => game.nowEpochMs });
            // PostgreSQL claims by wall time. The game clock was advanced above; release only this already-due row.
            await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC' where ri_topic_id = ${ARENA_TOURNAMENT_FINISH_TOPIC}`;
            await restart.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await publisher.stop();
            expect(terminalRevisions).toEqual([(await game.snapshots.readSnapshot(RETENTION_REF, 'owner'))!.attemptRevision]);
            const finished = await game.service.read(tick('finished'), 'arena-test');
            expect(finished.state?.arena.match?.status).toBe('complete');
            const result = (await game.results.read(game.binding)).result;
            expect(result?.standings.map((entry) => entry.rank)).toEqual([1, 1]);
            expect(result?.startedAtEpochMs).toBe(game.attempt.startedAtEpochMs);
            expect(result?.finishedAtEpochMs).toBe(game.attempt.startedAtEpochMs! + 60000);
        }
        finally {
            await game.storage.close();
        }
    }, 15000);

    it('cancels a stale game write when the organizer invalidates the attempt after read', async () => {
        const game = await createArenaTournamentSqlFixture();
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
            expect(await game.snapshots.readSnapshot(RETENTION_REF, 'owner')).toMatchObject({ status: 'cancelled', state: null });
            expect((await game.service.read(tick('after'), 'arena-test')).state).toBeNull();
            expect((await commitArenaTournamentCommand(game, tick('retry'))).status).toBe('refused');
        }
        finally {
            await game.storage.close();
        }
    });

    it('does not accept a client-selected score or unauthenticated actor', async () => {
        const game = await createArenaTournamentSqlFixture();
        try {
            const command: ArenaTournamentMutation.Command = {
                kind: 'input',
                roomRef: RETENTION_REF,
                requestId: 'forged-actor',
                capturedAtEpochMs: 0,
                actor: { principalId: 'owner', sessionId: 'forged-session', issuedAtEpochMs: 1 },
                input: { sequence: 1, yaw: 0, pitch: 0, controls: EMPTY_INPUT }
            };
            expect((await commitArenaTournamentCommand(game, command)).status).toBe('refused');
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
        const game = await createArenaTournamentSqlFixture();
        try {
            const input = await connectOwner(game);
            expect((await commitArenaTournamentCommand(game, input)).status).toBe('applied');
            const before = (await game.service.read(tick('before'), 'arena-test')).state!;
            game.nowEpochMs += 100;
            await commitArenaTournamentCommand(game, tick('move'));
            const after = (await game.service.read(tick('after'), 'arena-test')).state!;
            expect(after.players[0].simulation.position).not.toEqual(before.players[0].simulation.position);
            expect(after.players[0].input.sequence).toBe(1);
            expect((await commitArenaTournamentCommand(game, input)).reason).toBe('stale-input');
        }
        finally {
            await game.storage.close();
        }
    });

    it.each(['authentication', 'presence'] as const)('rolls back input when %s is revoked after read', async (authority) => {
        const game = await createArenaTournamentSqlFixture();
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
            expect((await commitArenaTournamentCommand(game, input)).status).toBe('refused');
        }
        finally {
            await game.storage.close();
        }
    });

    it('uses AppInbox for durable admission, exact replay and changed-command rejection', async () => {
        const game = await createArenaTournamentSqlFixture();
        try {
            const runtime = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const published: TournamentMatchBinding[] = [];
            const operation = registerArenaTournamentInbox({
                appInbox: runtime.inbox,
                mutations: game.service,
                onCheckpointCommitted: (binding) => published.push(binding),
                nowEpochMs: () => game.nowEpochMs
            });
            runtime.inbox.start();
            const input = await connectOwner(game);
            const admitted = await operation.enqueue({ command: input, traceId: 'arena-input-test' });
            expect(admitted.left).toBeUndefined();
            expect((await game.service.read(tick('pending'), 'arena-test')).state).toBeNull();
            expect(published).toEqual([]);
            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const result = await admitted.right!.wait();
            expect(result.right?.status).toBe('applied');
            const before = await game.service.read(tick('before-replay'), 'arena-test');
            game.nowEpochMs += 500;
            const replay = await operation.submit({ command: input, traceId: 'arena-input-replay' });
            expect(replay.right).toEqual(result.right);
            const after = await game.service.read(tick('after-replay'), 'arena-test');
            expect(after.save).toEqual(before.save);
            expect(published).toEqual([game.binding]);
            const changed = await operation.enqueue({ command: { ...input, input: { ...input.input, sequence: 2 } }, traceId: 'arena-input-conflict' });
            expect(changed.left?.status).toBe(409);
        }
        finally {
            await game.storage.close();
        }
    });
    it('does not publish or advance the attempt if the checkpoint outbox write is rolled back', async () => {
        const game = await createArenaTournamentSqlFixture();
        try {
            const runtime = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const published: TournamentMatchBinding[] = [];
            const operation = registerArenaTournamentInbox({
                appInbox: runtime.inbox,
                mutations: game.service,
                onCheckpointCommitted: (binding) => published.push(binding),
                nowEpochMs: () => game.nowEpochMs
            });
            runtime.inbox.start();
            const before = await game.snapshots.readSnapshot(RETENTION_REF, 'owner');
            const input = await connectOwner(game);
            await game.storage.sql`create function reject_arena_clock() returns trigger language plpgsql as
                'begin if NEW.ri_topic_id = ''app:ar-eye:tournament-clock'' then return null; end if; return NEW; end'`;
            await game.storage.sql`create trigger reject_arena_clock before insert on resource_inbox for each row execute function reject_arena_clock()`;
            const admitted = await operation.enqueue({ command: input, traceId: 'arena-rollback' });
            expect(admitted.left).toBeUndefined();
            await runtime.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const after = await game.snapshots.readSnapshot(RETENTION_REF, 'owner');
            expect(after?.state).toBeNull();
            expect(after?.attemptRevision).toBe(before?.attemptRevision);
            expect(published).toEqual([]);
        }
        finally {
            await game.storage.close();
        }
    });

    it('recovers the durable clock after restart when input already advanced its due step', async () => {
        const game = await createArenaTournamentSqlFixture();
        try {
            const input = await connectOwner(game);
            await commitArenaTournamentCommand(game, input);
            const unrelatedBefore = await game.storage.sql<readonly ArenaQueueObservation[]>`select ri_topic_id, ri_status, ri_attempts from resource_inbox
                where ri_topic_id <> 'app:ar-eye:tournament-clock' order by ri_topic_id, ri_resource_id`;
            expect(unrelatedBefore.length).toBeGreaterThan(0);
            game.nowEpochMs += 50;
            await commitArenaTournamentCommand(game, { ...input, requestId: 'second-input', input: { ...input.input, sequence: 2 } });
            const runtime = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const operation = registerArenaTournamentInbox({
                appInbox: runtime.inbox,
                mutations: game.service,
                onCheckpointCommitted: () => {},
                nowEpochMs: () => game.nowEpochMs
            });
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
            expect(unrelatedAfter.filter((row) => row.ri_topic_id === 'app:ar-eye:tournament-finished')).toHaveLength(1);
            expect(unrelatedAfter.filter((row) => row.ri_topic_id !== 'app:ar-eye:tournament-finished')).toEqual(unrelatedBefore);
        }
        finally {
            await game.storage.close();
        }
    }, 30000);
});

async function waitForBlockedHydration(sql: PSqlSql, pid: number): Promise<void> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const waiting = await sql<{ pid: number; }[]>`select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
        if (waiting.length > 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Snapshot did not overlap the checkpoint writer');
}
