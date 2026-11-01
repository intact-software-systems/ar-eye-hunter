import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { MatchmakingCommand } from '@shared-server/rallar-system/matchmaking/matchmaking-command.ts';
import { installMatchmakingDeadline } from '@shared-server/rallar-system/matchmaking/matchmaking-deadline.ts';
import { MatchmakingRepository } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { MatchmakingService } from '@shared-server/rallar-system/matchmaking/matchmaking-service.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/canonical-json.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import type { MatchmakingRequest } from '@shared/api/matchmaking/matchmaking-request.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import type { SqlServerAppInboxTestRuntime } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createSqlServerAppInbox } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../app-inbox/test-support/test-app-inbox-finished-retention.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const policy = { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 };

describe('matchmaking through authenticated AppInbox', () => {
    it('replays a search without another mutation and rejects altered command reuse', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_inbox_replay');
        try {
            const { queue, repository, service, sessions } = await testRuntime(storage);
            const session = sessions[0]!;
            const command = testCommand(session, { action: 'start', searchId: 'alice-search' }, 'start-alice');
            const admitted = await service.mutate.enqueue({ command, traceId: 'first' });
            await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'applied', searchId: 'alice-search' });
            const after = await repository.read(scope);
            expect((await service.mutate.submit({ command, traceId: 'replay' })).right).toMatchObject({ status: 'applied' });
            expect(await repository.read(scope)).toEqual(after);
            const changed = await service.mutate.enqueue({ command: { ...command, request: { ...command.request, action: 'cancel' } }, traceId: 'changed' });
            expect(changed.left?.code).toBe('app-inbox-idempotency-conflict');
        }
        finally {
            await storage.close();
        }
    });

    it('creates one shared room only after both live accounts confirm', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_inbox_admit');
        try {
            const { queue, repository, service, sessions, groups, now } = await testRuntime(storage);
            for (const action of ['start', 'confirm'] as const) {
                for (const session of sessions) {
                    const command = testCommand(session, { action, searchId: `${session.clientId}-search` }, `${action}-${session.clientId}`);
                    const admitted = await service.mutate.enqueue({ command, traceId: command.requestId });
                    await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                    expect((await admitted.right!.wait()).right).toMatchObject({ status: 'applied' });
                    if (action === 'start' || session.clientId === 'alice') {
                        expect(await groups.readSnapshot({ ...scope, groupId: 'match-alice-search' })).toBeUndefined();
                    }
                }
            }
            const room = await groups.readSnapshot({ ...scope, groupId: 'match-alice-search' });
            expect(room?.members.map((member) => member.principalId).sort()).toEqual(['alice', 'bob']);
            expect(room?.group.maxMembers).toBe(2);
            expect(room?.group.maxSessionsPerMember).toBeNull();
            expect(room?.group.metadata.rallarRetention).toMatchObject({ mode: 'temporary' });
            expect((await repository.readCurrent({ scope, principalId: 'bob', nowEpochMs: now })).finished)
                .toMatchObject({ reason: 'matched', leaderPrincipalId: 'alice', roomRef: { ...scope, groupId: 'match-alice-search' } });
        }
        finally {
            await storage.close();
        }
    });
    it('refuses an enqueued command after its actor session is revoked', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_revoked_actor');
        try {
            const { queue, repository, service, sessions, auth } = await testRuntime(storage);
            const command = testCommand(sessions[0]!, { action: 'start', searchId: 'alice-search' }, 'revoked');
            const admitted = await service.mutate.enqueue({ command, traceId: 'revoked' });
            await auth.deleteSession(sessions[0]!);
            await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'unauthorized' });
            expect((await repository.read(scope)).pool.searching).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('releases the whole cohort when an already confirmed session is revoked', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_revoked_partner');
        try {
            const fixture = await testRuntime(storage);
            for (const session of fixture.sessions) {
                await runCommand(fixture, testCommand(session, { action: 'start', searchId: `${session.clientId}-search` }, `start-${session.clientId}`));
            }
            await runCommand(fixture, testCommand(fixture.sessions[0]!, { action: 'confirm', searchId: 'alice-search' }, 'confirm-alice'));
            await fixture.auth.deleteSession(fixture.sessions[0]!);
            await runCommand(fixture, testCommand(fixture.sessions[1]!, { action: 'confirm', searchId: 'bob-search' }, 'confirm-bob'));
            expect(await fixture.groups.readSnapshot({ ...scope, groupId: 'match-alice-search' })).toBeUndefined();
            expect((await fixture.repository.read(scope)).pool.proposals).toEqual([]);
            for (const principalId of ['alice', 'bob']) {
                const current = await fixture.repository.readCurrent({ scope, principalId, nowEpochMs: fixture.now });
                expect(current.finished).toMatchObject({ reason: 'admission-denied', roomRef: null });
            }
        }
        finally {
            await storage.close();
        }
    });

    it('expires a persisted confirmation without either browser and does not end a replacement search', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_expiry_recovery');
        try {
            const fixture = await testRuntime(storage);
            for (const session of fixture.sessions) {
                await runCommand(fixture, testCommand(session, { action: 'start', searchId: `${session.clientId}-search` }, `start-${session.clientId}`));
            }
            fixture.clock.now = fixture.now + policy.confirmationTimeoutMs;
            const command = { scope, deadlineId: computeSha256CanonicalJson('confirmation-generation'), dueAtEpochMs: fixture.clock.now };
            const admitted = await fixture.service.expire.enqueue({ command, traceId: 'expire' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toEqual(command);
            for (const principalId of ['alice', 'bob']) {
                expect((await fixture.repository.readCurrent({ scope, principalId, nowEpochMs: fixture.clock.now })).finished)
                    .toMatchObject({ reason: 'confirmation-timeout', roomRef: null });
            }
            await runCommand(fixture, testCommand(fixture.sessions[0]!, { action: 'start', searchId: 'alice-again' }, 'start-again'));
            expect((await fixture.service.expire.submit({ command, traceId: 'late-replay' })).right).toEqual(command);
            expect((await fixture.repository.read(scope)).pool.searching.map((search) => search.searchId)).toEqual(['alice-again']);
            expect(await fixture.groups.readSnapshot({ ...scope, groupId: 'match-alice-search' })).toBeUndefined();
        }
        finally {
            await storage.close();
        }
    });
    it('delivers the committed search timer through the outbox after the browser disappears', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_outbox_expiry');
        try {
            const fixture = await testRuntime(storage, { ...policy, searchTimeoutMs: 1000 });
            await runCommand(fixture, testCommand(fixture.sessions[0]!, { action: 'start', searchId: 'alice-search' }, 'start-alice'));
            expect(await fixture.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0))).toBe(0);
            await vi.waitFor(async () => {
                fixture.clock.now = Date.now();
                expect(await fixture.queue.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0))).toBe(1);
            }, { timeout: 4000, interval: 50 });

            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.repository.readCurrent({ scope, principalId: 'alice', nowEpochMs: fixture.clock.now })).finished)
                .toMatchObject({ reason: 'search-timeout' });
            expect((await fixture.repository.read(scope)).pool.searching).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });
    it('rolls back a stale authorization read and lets the outer queue retry against revocation', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_auth_cas');
        try {
            const fixture = await testRuntime(storage);
            const readSession = fixture.auth.findSessionBySessionIdEntry.bind(fixture.auth);
            vi.spyOn(fixture.auth, 'findSessionBySessionIdEntry').mockImplementationOnce(async (sessionId) => {
                const observed = await readSession(sessionId);
                await fixture.auth.deleteSession(fixture.sessions[0]!);
                return observed;
            });
            const command = testCommand(fixture.sessions[0]!, { action: 'start', searchId: 'alice-search' }, 'race-revocation');
            const admitted = await fixture.service.mutate.enqueue({ command, traceId: 'revoke-between-read-and-write' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.repository.read(scope)).entry).toBeNull();
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'unauthorized' });
            expect((await fixture.repository.read(scope)).pool.searching).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('releases a later cohort if its proposed destination identity is already occupied', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_room_collision');
        try {
            const fixture = await testRuntime(storage);
            for (const action of ['start', 'confirm'] as const) {
                for (const session of fixture.sessions) {
                    await runCommand(fixture, testCommand(session, { action, searchId: `${session.clientId}-search` }, `${action}-${session.clientId}`));
                }
            }
            const later = [testSession('carol', fixture.now), testSession('dan', fixture.now)];
            for (const session of later) {
                await fixture.auth.putSession(session);
            }
            for (const action of ['start', 'confirm'] as const) {
                for (const session of later) {
                    await runCommand(
                        fixture,
                        testCommand(
                            session,
                            { action, searchId: session.clientId === 'carol' ? 'alice-search' : 'dan-search' },
                            `${action}-${session.clientId}`
                        )
                    );
                }
            }
            expect((await fixture.repository.readCurrent({ scope, principalId: 'carol', nowEpochMs: fixture.now })).finished)
                .toMatchObject({ reason: 'admission-denied', roomRef: null });
            expect((await fixture.groups.readSnapshot({ ...scope, groupId: 'match-alice-search' }))?.members.map((member) => member.principalId).sort())
                .toEqual(['alice', 'bob']);
        }
        finally {
            await storage.close();
        }
    });
    it('uses the default policy when an application name matches an inherited object property', async () => {
        const storage = await createResourceInboxTestStorage('matchmaking_policy_lookup');
        try {
            const fixture = await testRuntime(storage);
            const command = {
                ...testCommand(fixture.sessions[0]!, { action: 'start', searchId: 'alice-search' }, 'start-alice'),
                scope: { ...scope, applicationId: 'constructor' }
            };
            await runCommand(fixture, command);
            expect((await fixture.repository.read(command.scope)).pool.searching[0]?.expiresAtEpochMs).toBe(fixture.now + policy.searchTimeoutMs);
        }
        finally {
            await storage.close();
        }
    });
});

function testSession(principalId: string, now: number): IssuedAuthSession {
    return {
        clientId: principalId,
        username: principalId,
        sessionId: `session-${principalId}`,
        accessToken: `test-only-${principalId}`,
        issuedAtEpochMs: now - 1000,
        expiresAtEpochMs: now + 600000
    };
}

function testCommand(session: IssuedAuthSession, request: MatchmakingRequest, requestId: string): MatchmakingCommand {
    return {
        scope,
        principalId: session.clientId,
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        requestId,
        request,
        capturedAtEpochMs: null,
        policy: null,
        serviceId: null
    };
}

interface MatchmakingTestRuntime {
    readonly queue: SqlServerAppInboxTestRuntime;
    readonly repository: MatchmakingRepository;
    readonly service: MatchmakingService;
    readonly sessions: readonly IssuedAuthSession[];
    readonly auth: AuthSessionRepository;
    readonly groups: GroupStateRepository;
    readonly now: number;
    readonly clock: { now: number; };
}

async function testRuntime(storage: ResourceInboxTestStorage, configuredPolicy: MatchmakingPolicy = policy): Promise<MatchmakingTestRuntime> {
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const now = Date.now();
    const clock = { now };
    const queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => clock.now });
    const auth = new AuthSessionRepository(runtime);
    const repository = new MatchmakingRepository(runtime);
    const groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(storage.sql));
    const sessions = [testSession('alice', now), testSession('bob', now)];
    for (const session of sessions) {
        await auth.putSession(session);
    }
    const service = new MatchmakingService(
        { appInbox: queue.inbox, repository, authSessions: auth, groups, nowEpochMs: () => clock.now, timing: undefined },
        {
            serviceId: 'match-test',
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            defaultPolicy: configuredPolicy,
            policiesByApplication: {}
        }
    );
    installMatchmakingDeadline({
        outboxQueueReader: queue.outbox,
        nowEpochMs: () => clock.now,
        enqueue: async (command, traceId) => {
            const result = await service.expire.enqueue({ command, traceId });
            if (result.left !== undefined) {
                throw new Error(result.left.message);
            }
        }
    });
    queue.inbox.start();
    return { queue, auth, repository, groups, now, clock, sessions, service };
}

async function runCommand(fixture: MatchmakingTestRuntime, command: MatchmakingCommand): Promise<void> {
    const admitted = await fixture.service.mutate.enqueue({ command, traceId: command.requestId });
    await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
    expect((await admitted.right!.wait()).right).toMatchObject({ status: 'applied' });
}
