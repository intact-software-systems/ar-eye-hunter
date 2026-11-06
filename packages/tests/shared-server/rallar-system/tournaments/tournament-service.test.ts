import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { registerTournamentInbox } from '@shared-server/rallar-system/tournaments/register-tournament-inbox.ts';
import { TournamentRepository } from '@shared-server/rallar-system/tournaments/tournament-repository.ts';
import { computeTournamentResultPublication, writeTournamentGame } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { createTournamentResult } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import { installTournamentGameLifecycle, installTournamentReconciliation } from '@shared-server/rallar-system/tournaments/tournament-signals.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { TournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import type { TournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import type { TournamentAttempt } from '@shared/api/tournaments/tournament-types.ts';
import type { ViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import { decodeViewInvalidationMessage } from '@shared/api/views/view-invalidation.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { createSqlServerAppInbox, type SqlServerAppInboxTestRuntime } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createTestAuthSession } from '../group-state/group-state-test-runtime.ts';
import { createRetentionDatabaseFixture, type RetentionDatabaseFixture } from '../group-state/retention/group-retention-database-fixture.ts';

const REF = { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' };

describe('tournament AppInbox mutations', () => {
    it('keeps new tournaments unlisted and permits only the organizer to publish or unlist with exact replay', async () => {
        const game = await fixture();
        try {
            await execute(game, input(game.owner, { type: 'create', title: 'Friday cup' }));
            expect((await game.tournaments.readPublication(REF)).record).toBeNull();
            expect(await execute(game, input(game.players[0], { type: 'publish' }))).toMatchObject({ status: 'refused', code: 'organizer-required' });
            const command = input(game.owner, { type: 'publish' }, 'publish-cup');
            expect((await execute(game, command)).status).toBe('applied');
            const published = await game.tournaments.readPublication(REF);
            expect(published.record).toEqual({ ref: REF, listing: 'listed' });
            expect((await game.operation.submit({ command, traceId: 'replay-publish' })).right?.status).toBe('applied');
            expect(await game.tournaments.readPublication(REF)).toEqual(published);
            expect((await game.operation.enqueue({ command: { ...command, request: { type: 'unlist' } }, traceId: 'changed-publish' })).left?.status).toBe(409);
            await execute(game, input(game.players[0], { type: 'register' }));
            await execute(game, input(game.owner, { type: 'unlist' }));
            expect((await game.tournaments.readPublication(REF)).record).toEqual({ ref: REF, listing: 'unlisted' });
            expect((await game.tournaments.read(REF)).record!.tournament.entrants.map((entry) => entry.principalId)).toEqual(['alice']);
        }
        finally {
            await game.storage.close();
        }
    });

    it('rejects a stale publication after cancellation and recomputes the lifecycle refusal', async () => {
        const game = await fixture();
        try {
            await execute(game, input(game.owner, { type: 'create', title: 'Friday cup' }));
            const command = game.service.materialize(input(game.owner, { type: 'publish' }));
            const read = await game.service.read(command, { attemptCount: 1, traceId: 'publish-race' });
            const computed = game.service.compute(read);
            expect(game.service.validate(read, computed)).toEqual([]);
            await execute(game, input(game.owner, { type: 'cancel' }));
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect((await game.tournaments.readPublication(REF)).record).toBeNull();
            const fresh = await game.service.read(command, { attemptCount: 2, traceId: 'publish-race' });
            expect(game.service.compute(fresh).result).toMatchObject({ status: 'refused', code: 'tournament-finished' });
        }
        finally {
            await game.storage.close();
        }
    });

    it('fences concurrent publication changes and detects a tampered publication projection', async () => {
        const game = await fixture();
        try {
            await execute(game, input(game.owner, { type: 'create', title: 'Friday cup' }));
            await execute(game, input(game.owner, { type: 'publish' }));
            const command = game.service.materialize(input(game.owner, { type: 'unlist' }));
            const read = await game.service.read(command, { attemptCount: 1, traceId: 'unlist-race' });
            const computed = game.service.compute(read);
            expect(game.service.validate(read, { ...computed, storage: null })).not.toEqual([]);
            expect(computed.outbox.length).toBeGreaterThan(0);
            expect(game.service.validate(read, { ...computed, outbox: [] })).not.toEqual([]);
            await execute(game, input(game.owner, { type: 'publish' }));
            const winner = await game.tournaments.readPublication(REF);
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect(await game.tournaments.readPublication(REF)).toEqual(winner);
            const fresh = await game.service.read(command, { attemptCount: 2, traceId: 'unlist-race' });
            const recomputed = game.service.compute(fresh);
            expect(game.service.validate(fresh, recomputed)).toEqual([]);
            await game.storage.sql.begin((transaction) => game.service.write(transaction, recomputed));
            expect((await game.tournaments.readPublication(REF)).record?.listing).toBe('unlisted');
        }
        finally {
            await game.storage.close();
        }
    });

    it('rolls back publication and its bracket guard when the organizer session is revoked before commit', async () => {
        const game = await fixture();
        try {
            await execute(game, input(game.owner, { type: 'create', title: 'Friday cup' }));
            const before = await game.tournaments.read(REF);
            const command = game.service.materialize(input(game.owner, { type: 'publish' }));
            const read = await game.service.read(command, { attemptCount: 1, traceId: 'publication-revocation' });
            const computed = game.service.compute(read);
            await game.sessions.deleteSession(game.owner);
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect(await game.tournaments.read(REF)).toEqual(before);
            expect((await game.tournaments.readPublication(REF)).record).toBeNull();
            const fresh = await game.service.read(command, { attemptCount: 2, traceId: 'publication-revocation' });
            expect(game.service.compute(fresh).result).toMatchObject({ status: 'refused', code: 'unauthorized' });
        }
        finally {
            await game.storage.close();
        }
    });

    it('replays the exact acknowledgement without another write and rejects changed intent under the same request', async () => {
        const game = await fixture();
        try {
            const command = input(game.owner, { type: 'create', title: 'Friday cup' }, 'create');
            expect((await execute(game, command)).status).toBe('applied');
            const before = await game.tournaments.read(REF);
            game.nowEpochMs += 1000;
            const replay = await game.operation.submit({ command, traceId: 'replay-create' });
            expect(replay.right?.status).toBe('applied');
            expect((await game.tournaments.read(REF)).entry).toEqual(before.entry);
            expect(
                (await game.operation.enqueue({ command: { ...command, request: { type: 'create', title: 'Different cup' } }, traceId: 'changed-create' })).left
                    ?.status
            ).toBe(409);
        }
        finally {
            await game.storage.close();
        }
    });

    it('admits both checked-in competitors and starts only their exact private attempt in one transaction', async () => {
        const game = await fixture();
        try {
            const attempt = await checkedInBracket(game);
            const started = await execute(game, input(game.owner, { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId }));
            expect(started.status).toBe('applied');
            const members = await game.repository.listMembers(attempt.binding.roomRef);
            expect(members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
            expect((await game.repository.findGroup(attempt.binding.roomRef))?.metadata.rallarRetention)
                .toMatchObject({ mode: 'temporary', reconnectGraceMs: 900000 });
            const current = await game.tournaments.read(REF);
            expect(current.record!.tournament.matches[0].status).toBe('playing');
            expect(current.attempts[0].attempt?.status).toBe('playing');
        }
        finally {
            await game.storage.close();
        }
    });

    it('refuses all admission if a checked-in session was revoked before start', async () => {
        const game = await fixture();
        try {
            const attempt = await checkedInBracket(game);
            await game.sessions.deleteSession(game.players[1]);
            const started = await execute(game, input(game.owner, { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId }));
            expect(started).toMatchObject({ status: 'refused', code: 'check-in-session-expired' });
            expect(await game.repository.findGroup(attempt.binding.roomRef)).toBeUndefined();
            expect((await game.tournaments.read(REF)).record!.tournament.matches[0].status).toBe('scheduled');
        }
        finally {
            await game.storage.close();
        }
    });

    it.each([0, 1])('recovers the no-show deadline after restart with %i checked-in players', async (checkedInCount) => {
        const game = await fixture();
        try {
            const attempt = await checkedInBracket(game, checkedInCount);
            game.nowEpochMs = attempt.scheduledAtEpochMs + 600000;
            const restarted = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const operation = registerTournamentInbox({ appInbox: restarted.inbox, service: game.service });
            installTournamentReconciliation({ outbox: restarted.outbox, operation, nowEpochMs: () => game.nowEpochMs });
            restarted.inbox.start();
            await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC'
                where ri_topic_id = 'app:rallar-tournaments:reconcile' and next_ts <= ${new Date(game.nowEpochMs).toISOString()}::timestamp`;
            await restarted.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await restarted.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const match = (await game.tournaments.read(REF)).record!.tournament.matches[0];
            expect(match.status).toBe(checkedInCount === 1 ? 'complete' : 'unresolved');
            expect(match.resolution?.winnerPrincipalId ?? null).toBe(checkedInCount === 1 ? 'alice' : null);
            expect(await game.repository.findGroup(attempt.binding.roomRef)).toBeUndefined();
        }
        finally {
            await game.storage.close();
        }
    });

    it('recovers a native result publication after restart and advances its exact bracket slot once', async () => {
        const game = await fixture();
        try {
            const attempt = await checkedInBracket(game);
            await execute(game, input(game.owner, { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId }));
            const started = await game.tournaments.read(REF);
            const startedAtEpochMs = started.attempts[0].attempt!.startedAtEpochMs!;
            game.nowEpochMs += 60000;
            // This integration fixture represents the trusted game-owner boundary. Native scoring has its own game tests.
            const result = createTournamentResult({
                binding: attempt.binding,
                authority: { kind: 'server', id: 'game-owner', epoch: 1 },
                startedAtEpochMs,
                finishedAtEpochMs: game.nowEpochMs,
                scores: [10, 0]
            });
            const publication = computeTournamentResultPublication(started.attempts[0], result, game.nowEpochMs);
            if (publication.kind !== 'publish') {
                throw new Error('Expected new native result');
            }
            await game.storage.sql.begin((transaction) => writeTournamentGame(transaction, publication.write));
            const restarted = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
            const operation = registerTournamentInbox({ appInbox: restarted.inbox, service: game.service });
            installTournamentReconciliation({ outbox: restarted.outbox, operation, nowEpochMs: () => game.nowEpochMs });
            restarted.inbox.start();
            await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC'
                where ri_topic_id = 'app:rallar-tournaments:reconcile' and next_ts <= ${new Date(game.nowEpochMs).toISOString()}::timestamp`;
            await restarted.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await restarted.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const after = await game.tournaments.read(REF);
            expect(after.record!.tournament.matches[0].resolution).toMatchObject({ winnerPrincipalId: 'alice', reason: 'score', resultId: result.resultId });
            expect(after.record!.tournament.matches[1].resolution).toBeNull();
            await execute(game, { ref: REF, requestId: 'repeated-reconcile', actor: null, request: { type: 'reconcile' }, materialized: null });
            expect((await game.tournaments.read(REF)).entry).toEqual(after.entry);
        }
        finally {
            await game.storage.close();
        }
    });

    it('keeps the game-start and bracket-deadline handlers independent in an embedded application server', async () => {
        const game = await fixture();
        try {
            const starts: string[] = [];
            installTournamentReconciliation({ outbox: game.queue.outbox, operation: game.operation, nowEpochMs: () => game.nowEpochMs });
            installTournamentGameLifecycle({
                outbox: game.queue.outbox,
                topic: 'app:test:game-start',
                nowEpochMs: () => game.nowEpochMs,
                enqueue: async (binding) => {
                    starts.push(binding.attemptId);
                }
            });
            const attempt = await checkedInBracket(game);
            await execute(game, input(game.owner, { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId }));
            await game.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(starts).toEqual([attempt.binding.attemptId]);
            await execute(game, input(game.owner, { type: 'schedule', slot: 'semifinal-2', scheduledAtEpochMs: game.nowEpochMs }));
            game.nowEpochMs += 600000;
            await game.storage.sql`update resource_inbox set next_ts = now() at time zone 'UTC'
                where ri_topic_id = 'app:rallar-tournaments:reconcile' and next_ts <= ${new Date(game.nowEpochMs).toISOString()}::timestamp`;
            await game.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            await game.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await game.tournaments.read(REF)).record!.tournament.matches[1].status).toBe('unresolved');
            expect(starts).toEqual([attempt.binding.attemptId]);
        }
        finally {
            await game.storage.close();
        }
    });

    it('commits one game-start signal with admission and does not duplicate it on replay', async () => {
        const game = await fixture();
        try {
            const attempt = await checkedInBracket(game);
            const command = input(game.owner, { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId });
            expect((await execute(game, command)).status).toBe('applied');
            expect((await game.operation.submit({ command, traceId: 'replay-start' })).right?.status).toBe('applied');
            const rows = await game.storage.sql<
                readonly { count: number; }[]
            >`select count(*)::integer as count from resource_inbox where ri_topic_id = 'app:test:game-start'`;
            expect(rows[0].count).toBe(1);
        }
        finally {
            await game.storage.close();
        }
    });

    it.each(['cancel', 'reschedule'] as const)('commits one cancellation signal on %s and preserves it on replay', async (transition) => {
        const game = await fixture();
        try {
            const attempt = await checkedInBracket(game);
            await execute(game, input(game.owner, { type: 'start', slot: 'semifinal-1', attemptId: attempt.binding.attemptId }));
            const request: TournamentRequest = transition === 'cancel'
                ? { type: 'cancel' }
                : { type: 'schedule', slot: 'semifinal-1', scheduledAtEpochMs: game.nowEpochMs };
            const command = input(game.owner, request, 'cancel-cup');
            expect((await execute(game, command)).status).toBe('applied');
            expect((await game.operation.submit({ command, traceId: 'repeat-cancel' })).right?.status).toBe('applied');
            const rows = await game.storage.sql<readonly { resource: string; }[]>`
                select ri_resource as resource from resource_inbox where ri_topic_id = 'app:test:game-start'
            `;
            const signals = rows.map((row) => JSON.parse(JSON.parse(row.resource).payload.resource));
            expect(signals.filter((signal) => signal.kind === 'cancel')).toEqual([
                { kind: 'cancel', binding: attempt.binding, dueAtEpochMs: game.nowEpochMs }
            ]);
        }
        finally {
            await game.storage.close();
        }
    });

    it('rolls back a prepared registration if its authentication is revoked before commit', async () => {
        const game = await fixture();
        try {
            await execute(game, input(game.owner, { type: 'create', title: 'Friday cup' }));
            const command = game.service.materialize(input(game.players[0], { type: 'register' }));
            const read = await game.service.read(command, { attemptCount: 1, traceId: 'registration-race' });
            const computed = game.service.compute(read);
            expect(game.service.validate(read, computed)).toEqual([]);
            await game.sessions.deleteSession(game.players[0]);
            await expect(game.storage.sql.begin((transaction) => game.service.write(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect((await game.tournaments.read(REF)).record!.tournament.entrants).toEqual([]);
        }
        finally {
            await game.storage.close();
        }
    });
});

interface TournamentServiceFixture extends RetentionDatabaseFixture {
    readonly sessions: AuthSessionPersistence;
    readonly players: readonly IssuedAuthSession[];
    readonly tournaments: TournamentRepository;
    readonly service: TournamentService;
    readonly queue: SqlServerAppInboxTestRuntime;
    readonly operation: RallarServerAppInbox.Operation<TournamentService.Command, TournamentMutationResult>;
}

async function fixture(): Promise<TournamentServiceFixture> {
    const game = await createRetentionDatabaseFixture();
    const sessions = new AuthSessionPersistence(game.runtime);
    const owner = { ...game.owner, expiresAtEpochMs: game.nowEpochMs + 86400000 };
    await sessions.putSession(owner);
    const players = ['alice', 'bob', 'charlie', 'dana'].map((principalId) => ({
        ...createTestAuthSession(principalId),
        expiresAtEpochMs: owner.expiresAtEpochMs
    }));
    for (const player of players) {
        await sessions.putSession(player);
    }
    const tournaments = new TournamentRepository(game.runtime);
    let identity = 0;
    const service = new TournamentService({ repository: tournaments, sessions, groups: game.repository }, {
        createId: () => `tournament-identity-${++identity}`,
        nowEpochMs: () => game.nowEpochMs,
        serviceId: 'tournament-owner',
        finishedRetentionMs: 3600000,
        profiles: [{
            scope: { applicationId: REF.applicationId, workspaceId: REF.workspaceId },
            rulesId: 'native',
            noShowGraceMs: 600000,
            gameLifecycleTopic: 'app:test:game-start'
        }]
    });
    const queue = createSqlServerAppInbox({ database: game.storage.sql, nowEpochMs: () => game.nowEpochMs });
    const operation = registerTournamentInbox({ appInbox: queue.inbox, service });
    queue.inbox.start();
    return Object.assign(game, { owner, sessions, players, tournaments, service, queue, operation });
}

function input(
    session: IssuedAuthSession,
    request: TournamentRequest,
    requestId: string = crypto.randomUUID()
): TournamentService.Command {
    return {
        ref: REF,
        requestId,
        actor: { principalId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs },
        request,
        materialized: null
    };
}

async function execute(game: TournamentServiceFixture, command: TournamentService.Command): Promise<TournamentMutationResult> {
    const admitted = await game.operation.enqueue({ command, traceId: 'tournament-service' });
    expect(admitted.left).toBeUndefined();
    await game.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
    const result = await admitted.right!.wait();
    expect(result.left).toBeUndefined();
    return result.right!;
}

async function checkedInBracket(game: TournamentServiceFixture, checkedInCount = 2): Promise<TournamentAttempt> {
    expect((await execute(game, input(game.owner, { type: 'create', title: 'Friday cup' }))).status).toBe('applied');
    for (const player of game.players) {
        expect((await execute(game, input(player, { type: 'register' }))).status).toBe('applied');
    }
    expect((await execute(game, input(game.owner, { type: 'launch' }))).status).toBe('applied');
    expect((await execute(game, input(game.owner, { type: 'schedule', slot: 'semifinal-1', scheduledAtEpochMs: game.nowEpochMs }))).status).toBe('applied');
    const attempt = (await game.tournaments.read(REF)).record!.tournament.matches[0].attempt!;
    for (const player of game.players.slice(0, checkedInCount)) {
        expect((await execute(game, input(player, { type: 'check-in', slot: 'semifinal-1', attemptId: attempt.binding.attemptId }))).status).toBe('applied');
    }
    return attempt;
}

it('publishes private catalog and bracket changes while limiting public notices to discoverable projection changes', async () => {
    const game = await fixture();
    try {
        const create = input(game.owner, { type: 'create', title: 'Private cup' }, 'create-secret-cup');
        await execute(game, create);
        const privateNotices = await viewNotices(game);
        expect(privateNotices).toHaveLength(2);
        expect(privateNotices.every((notice) => notice.principalId === game.owner.clientId)).toBe(true);
        expect(privateNotices.map((notice) => notice.resource).sort()).toEqual(['tournament', 'tournament-catalog']);
        await execute(game, create);
        expect(await viewNotices(game)).toEqual(privateNotices);
        await execute(game, input(game.owner, { type: 'publish' }, 'publish-secret-cup'));
        expect((await viewNotices(game)).filter((notice) => notice.principalId === null)).toHaveLength(1);
        await execute(game, input(game.players[0], { type: 'register' }));
        expect((await viewNotices(game)).filter((notice) => notice.principalId === null)).toHaveLength(2);
        await execute(game, input(game.players[0], { type: 'withdraw' }));
        expect((await viewNotices(game)).filter((notice) => notice.principalId === null)).toHaveLength(3);
        await execute(game, input(game.owner, { type: 'unlist' }));
        const afterUnlist = await viewNotices(game);
        expect(afterUnlist.filter((notice) => notice.principalId === null)).toHaveLength(4);
        await execute(game, input(game.owner, { type: 'cancel' }));
        const final = await viewNotices(game);
        expect(final.filter((notice) => notice.principalId === null)).toHaveLength(4);
        expect(final.filter((notice) => notice.principalId === game.players[0].clientId).length).toBeGreaterThan(0);
        expect(final.every((notice) => /^[a-f0-9]{64}$/.test(notice.changeId))).toBe(true);
    }
    finally {
        await game.storage.close();
    }
});

async function viewNotices(game: TournamentServiceFixture): Promise<readonly ViewInvalidation[]> {
    const rows = await game.storage.sql<{ ri_resource: string; }[]>`
        select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated' order by ri_resource_id`;
    return rows.map((row) => decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(row.ri_resource))));
}
