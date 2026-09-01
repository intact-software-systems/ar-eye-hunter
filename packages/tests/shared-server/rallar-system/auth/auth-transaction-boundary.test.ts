import { Temporal } from '@js-temporal/polyfill';
import { expect, it, vi } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { PersistedAuthUser } from '@shared-server/rallar-system/auth/persistence/persisted-auth-user.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAuthInboxTestRuntime, type AuthInboxTestRuntime } from './auth-app-inbox-test-runtime.ts';

const SERVICE_ID = 'auth-test-service';

it(
    'commits issued session, durable result, and completion in one AppInbox transaction',
    commitsIssuedSessionAndResultAtomically
);

it(
    'denies registered-user session issuance when the user is disabled after enqueue',
    deniesSessionWhenUserIsDisabledAfterEnqueue
);

it(
    'rereads registered-user policy after a conflict is released for retry',
    rereadsUserPolicyAfterRetryConflict
);

async function commitsIssuedSessionAndResultAtomically(): Promise<void> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const credentialSecret = 'test-auth-secret-0123456789abcdef-extra';
    const fixture = createAuthInboxTestRuntime({
        runtimeRepository,
        serviceId: SERVICE_ID,
        credentialSecret
    });
    const pending = fixture.service.issueSession({
        requestId: 'issue-session-1',
        clientId: 'client-1',
        username: 'alice',
        authority: {
            kind: 'static-client',
            clientId: 'client-1',
            normalizedUsername: 'alice'
        },
        ttlMs: 60_000
    });
    await fixture.queue.waitForEntryCount();
    await dequeue(fixture);
    const result = await pending;

    if (!result.right) {
        throw new Error('Expected issued auth session');
    }
    const { accessToken, sessionId } = result.right;
    const sessions = new AuthSessionRepository(runtimeRepository);
    expect(await sessions.findByAccessToken(accessToken)).toMatchObject({ sessionId });
    expect(await sessions.findBySessionId(sessionId)).toMatchObject({ sessionId });
    await expectDurableIssueResult({ fixture, accessToken, credentialSecret });
}

interface DurableIssueResultExpectation {
    readonly fixture: AuthInboxTestRuntime;
    readonly accessToken: string;
    readonly credentialSecret: string;
}

async function expectDurableIssueResult({
    fixture,
    accessToken,
    credentialSecret
}: DurableIssueResultExpectation): Promise<void> {
    const entries = await fixture.queue.readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(EntityStatus.COMPLETED);
    expect(entries[0].resource).not.toContain(accessToken);
    expect(entries[0].resource).not.toContain(credentialSecret);
    const resultEntry = await fixture.results.findByKey(entries[0].key);
    expect(resultEntry?.resource).not.toContain(accessToken);
    expect(resultEntry?.resource).not.toContain(credentialSecret);
    expect(resultEntry?.resource).toContain('accessTokenDigest');
}

async function deniesSessionWhenUserIsDisabledAfterEnqueue(): Promise<void> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const fixture = createAuthInboxTestRuntime({
        runtimeRepository,
        serviceId: SERVICE_ID,
        credentialSecret: 'disabled-user-secret-0123456789abcdef'
    });
    const user = createRegisteredUser('client-disabled', 'disabled-user');
    const users = new AuthUserRepository(runtimeRepository);
    await users.putUser(user);
    const pending = fixture.service.issueSession({
        requestId: 'disabled-session-request',
        clientId: user.clientId,
        username: user.username,
        ttlMs: 60_000,
        authority: registeredUserAuthority(user)
    });
    await fixture.queue.waitForEntryCount();
    await users.putUser({ ...user, status: 'disabled', updatedAtEpochMs: 1_001 });
    await dequeue(fixture);

    const result = await pending;
    expect(result.left).toMatchObject({ status: 403 });
    expect(
        await new AuthSessionRepository(runtimeRepository).findBySessionId('disabled-session')
    ).toBeUndefined();
}

interface RetryFixture {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly auth: AuthInboxTestRuntime;
    readonly users: AuthUserRepository;
    readonly user: PersistedAuthUser;
    readonly conflict: { injected: boolean; rollbackCount: number; };
}

async function rereadsUserPolicyAfterRetryConflict(): Promise<void> {
    const fixture = await createRetryFixture();
    const userRead = vi.spyOn(fixture.runtimeRepository, 'findEntry');
    const pending = fixture.auth.service.issueSession({
        requestId: 'retry-disabled-session-request',
        clientId: fixture.user.clientId,
        username: fixture.user.username,
        ttlMs: 60_000,
        authority: registeredUserAuthority(fixture.user)
    });

    const releasedForRetry = await releaseConflictForRetry(fixture);
    await fixture.users.putUser({
        ...fixture.user,
        status: 'disabled',
        updatedAtEpochMs: 1_001
    });
    await fixture.auth.queue.enqueue({
        ...releasedForRetry,
        dequeueAudit: {
            ...releasedForRetry.dequeueAudit,
            nextTs: Temporal.Now.instant().subtract({ milliseconds: 1 })
        }
    });
    await dequeue(fixture.auth);

    const result = await pending;
    expect(result.left).toMatchObject({ status: 403 });
    expect(fixture.conflict.injected).toBe(true);
    expect(fixture.conflict.rollbackCount).toBe(1);
    expect(countPolicyReadCalls(userRead.mock.calls)).toBe(4);
    await expectFailedRetry(fixture);
}

async function createRetryFixture(): Promise<RetryFixture> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const users = new AuthUserRepository(runtimeRepository);
    const user = createRegisteredUser('client-retry-disabled', 'retry-disabled');
    await users.putUser(user);
    const conflict = { injected: false, rollbackCount: 0 };
    runtimeRepository.beforeConditionalWrite = async (operation, namespace, key) => {
        if (conflict.injected || operation !== 'insertIfAbsent') {
            return;
        }
        if (namespace !== 'auth-sessions:by-token') {
            return;
        }
        conflict.injected = true;
        await runtimeRepository.upsert(
            namespace,
            key,
            JSON.stringify({ collision: true }),
            Date.now() + 60_000
        );
    };
    const auth = createAuthInboxTestRuntime({
        runtimeRepository,
        serviceId: SERVICE_ID,
        credentialSecret: 'retry-disabled-secret-0123456789abcdef',
        databaseOptions: { onTransactionRollback: () => void (conflict.rollbackCount += 1) }
    });
    return { runtimeRepository, auth, users, user, conflict };
}

async function releaseConflictForRetry(fixture: RetryFixture): Promise<ResourceEntry> {
    await fixture.auth.queue.waitForEntryCount();
    await fixture.auth.reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAppInboxTestResilience(100)
    );
    const [releasedForRetry] = await fixture.auth.queue.readEntries();
    expect(releasedForRetry).toMatchObject({
        status: EntityStatus.RETRY,
        dequeueAudit: { attempts: 1 }
    });
    return releasedForRetry;
}

async function expectFailedRetry(fixture: RetryFixture): Promise<void> {
    const [failed] = await fixture.auth.queue.readEntries();
    expect(failed).toMatchObject({
        status: EntityStatus.FAILED,
        dequeueAudit: { attempts: 2 }
    });
    expect(fixture.auth.results.allEntries()).toEqual([
        expect.objectContaining({
            status: EntityStatus.FAILED,
            resource: expect.stringContaining('auth-mutation-rejected')
        })
    ]);
    expect(fixture.auth.results.allEntries()[0]?.resource).not.toContain('session-issued');
    expect(sessionStorageKeys(fixture.runtimeRepository)).toEqual([]);
    expect(
        await new AuthSessionRepository(fixture.runtimeRepository).findBySessionId(
            'retry-disabled-session'
        )
    ).toBeUndefined();
}

function createRegisteredUser(clientId: string, username: string): PersistedAuthUser {
    return {
        clientId,
        username,
        normalizedUsername: username,
        displayName: null,
        passwordHash: 'password-hash',
        passwordSalt: 'password-salt',
        passwordAlgorithm: 'pbkdf2-sha256',
        passwordIterations: 120_000,
        roles: ['member'],
        status: 'active',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000
    };
}

function registeredUserAuthority(user: PersistedAuthUser) {
    return {
        kind: 'registered-user' as const,
        clientId: user.clientId,
        normalizedUsername: user.normalizedUsername,
        userRevision: 0
    };
}

function countPolicyReadCalls(
    calls: readonly (readonly [namespace: string, key: string])[]
): number {
    return calls.filter(
        ([namespace]) => namespace === 'auth-users:by-username' || namespace === 'auth-users:by-client-id'
    ).length;
}

function sessionStorageKeys(runtimeRepository: FakeRuntimeStateRepository): readonly string[] {
    return [...runtimeRepository.data.keys()].filter(
        (key) => key.startsWith('auth-sessions:by-token:') || key.startsWith('auth-sessions:by-session:')
    );
}

async function dequeue(fixture: AuthInboxTestRuntime): Promise<void> {
    await fixture.reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAppInboxTestResilience()
    );
}
