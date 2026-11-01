import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { describe, expect, it, vi } from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import { FriendsAccountDirectory } from '@shared-server/rallar-system/friends/friends-account-directory.ts';
import type { FriendsCommand } from '@shared-server/rallar-system/friends/friends-mutation-contracts.ts';
import { FRIENDS_PROFILE_NAMESPACE } from '@shared-server/rallar-system/friends/friends-profile.ts';
import { FriendsRepository, writeFriendsProfiles } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { FriendsService } from '@shared-server/rallar-system/friends/friends-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';

async function createFriendsRuntime(revokeDuringRead = false) {
    const storage = await createResourceInboxTestStorage('friends_app_inbox');
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const { inbox, reader } = createFriendsQueue(storage.sql);
    const auth = new AuthSessionRepository(runtime);
    const profiles = new FriendsRepository(runtime);
    const now = Date.now();
    const session = {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'session-a',
        accessToken: 'test-only-token',
        issuedAtEpochMs: now - 100,
        expiresAtEpochMs: now + 60000
    };
    await auth.putSession(session);
    const accounts = new FriendsAccountDirectory(new AuthUserRepository(runtime), [
        { principalId: 'alice', username: 'alice', displayName: 'Alice' },
        { principalId: 'bob', username: 'bob', displayName: 'Bob' }
    ]);
    const timing: RallarTimingEvent[] = [];
    const service = new FriendsService({
        timing: (event) => timing.push(event),
        appInbox: inbox,
        profiles,
        authSessions: {
            findSessionBySessionIdEntry: async (sessionId) => {
                const observed = await auth.findSessionBySessionIdEntry(sessionId);
                if (revokeDuringRead) {
                    await auth.deleteSession(session);
                }
                return observed;
            }
        },
        accounts,
        groups: { readSnapshotWithAuthorityGuard: async () => undefined },
        nowEpochMs: () => now
    }, { maxContacts: 20, maxInvitations: 20, invitationLifetimeMs: 60000 });
    inbox.start();
    const command: FriendsCommand = {
        principalId: 'alice',
        sessionId: session.sessionId,
        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
        requestId: 'friend-bob',
        capturedAtEpochMs: null,
        request: { action: 'request', username: 'bob' }
    };
    return { storage, reader, service, profiles, auth, session, command, timing };
}

function createFriendsQueue(database: PSqlSql) {
    const entries = createPSqlResourceInboxRepository(database, () => new Date());
    const reader = new InboxQueueReader(new PSqlQueueBox(entries, Temporal.Now.instant), { newLaneConcurrency: 1 });
    const inbox = new RallarServerAppInbox({
        inboxQueueReader: reader,
        resourceInboxRepository: entries.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(database),
        database: database,
        wakeOwningQueue: () => {}
    }, {
        serviceId: 'friends-test',
        finishedRetentionMs: 60000,
        options: { waitMaxElapsedMsecs: 2000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 5, waitJitterRatio: 0 }
    });
    return { inbox, reader };
}

describe('authenticated friends commands through AppInbox', () => {
    it('replays the durable result without repeating the contact mutation and rejects changed command reuse', async () => {
        const fixture = await createFriendsRuntime();
        try {
            const admission = await fixture.service.mutate.enqueue({ command: fixture.command, traceId: 'request' });
            expect(admission.left).toBeUndefined();
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admission.right!.wait()).right).toEqual({ principalId: 'alice', requestId: 'friend-bob', status: 'applied' });
            expect(fixture.timing.map((event) => event.operation)).toEqual(['read', 'compute', 'validate', 'write', 'commit']);
            expect(fixture.timing.every((event) => event.traceId === 'request' && event.status === 'ok')).toBe(true);
            const after = await fixture.profiles.readProfile('alice');
            expect(after.profile.contacts).toEqual([{ principalId: 'bob', status: 'outgoing' }]);
            expect((await fixture.profiles.readProfile('bob')).profile.contacts).toEqual([{ principalId: 'alice', status: 'incoming' }]);
            expect((await fixture.service.mutate.submit({ command: fixture.command, traceId: 'replay' })).right)
                .toEqual({ principalId: 'alice', requestId: 'friend-bob', status: 'applied' });
            expect(await fixture.profiles.readProfile('alice')).toEqual(after);
            const conflict = await fixture.service.mutate.enqueue({
                command: { ...fixture.command, request: { action: 'visibility', shareOnline: true } },
                traceId: 'conflict'
            });
            expect(conflict.left).toMatchObject({ code: 'app-inbox-idempotency-conflict' });
        }
        finally {
            await fixture.storage.close();
        }
    });

    it.each(['block', 'cancel'] as const)('does not restore consent when %s wins against an accepted request', async (winner) => {
        const fixture = await createFriendsRuntime();
        try {
            const runtime = new PSqlRuntimeStateRepository(fixture.storage.sql);
            for (const [principalId, other, status] of [['alice', 'bob', 'incoming'], ['bob', 'alice', 'outgoing']]) {
                await runtime.upsert(
                    FRIENDS_PROFILE_NAMESPACE,
                    `principal=${principalId}`,
                    JSON.stringify({
                        principalId,
                        shareOnline: false,
                        contacts: [{ principalId: other, status }],
                        invitations: []
                    }),
                    NEVER_EXPIRE_AT_TIMESTAMP
                );
            }
            const readProfiles = fixture.profiles.readProfiles.bind(fixture.profiles);
            vi.spyOn(fixture.profiles, 'readProfiles').mockImplementationOnce(async (principals) => {
                const observed = await readProfiles(principals);
                const writes = observed.map(({ entry, profile }) => ({
                    key: entry!.key,
                    expectedRevision: entry!.revision,
                    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                    value: JSON.stringify({
                        ...profile,
                        contacts: winner === 'block' && profile.principalId === 'bob' ? [{ principalId: 'alice', status: 'blocked' }] : []
                    })
                }));
                await fixture.storage.sql.begin((transaction) => writeFriendsProfiles(transaction, writes));
                return observed;
            });
            const admission = await fixture.service.mutate.enqueue({
                command: { ...fixture.command, request: { action: 'accept', principalId: 'bob' } },
                traceId: 'consent-race'
            });
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const afterWinner = await readProfiles(['alice', 'bob']);
            expect(afterWinner[0]!.profile.contacts).toEqual([]);
            expect(afterWinner[1]!.profile.contacts).toEqual(winner === 'block' ? [{ principalId: 'alice', status: 'blocked' }] : []);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admission.right!.wait()).right).toMatchObject({ status: 'refused' });
            expect(await readProfiles(['alice', 'bob'])).toEqual(afterWinner);
            expect(fixture.timing.filter((event) => event.operation === 'read')).toHaveLength(2);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('refuses already admitted work after the issuing session is revoked', async () => {
        const fixture = await createFriendsRuntime();
        try {
            const admission = await fixture.service.mutate.enqueue({ command: fixture.command, traceId: 'revoked' });
            await fixture.auth.deleteSession(fixture.session);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admission.right!.wait()).right).toEqual({
                principalId: 'alice',
                requestId: 'friend-bob',
                status: 'refused',
                code: 'unauthorized'
            });
            expect((await fixture.profiles.readProfile('alice')).entry).toBeNull();
            expect((await fixture.profiles.readProfile('bob')).entry).toBeNull();
        }
        finally {
            await fixture.storage.close();
        }
    });
    it('rolls back stale consent after revocation wins between read and write, then rereads on redelivery', async () => {
        const fixture = await createFriendsRuntime(true);
        try {
            const admitted = await fixture.service.mutate.enqueue({ command: fixture.command, traceId: 'revocation-race' });
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.profiles.readProfile('alice')).entry).toBeNull();
            expect((await fixture.profiles.readProfile('bob')).entry).toBeNull();
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'unauthorized' });
        }
        finally {
            await fixture.storage.close();
        }
    });
});
