import { describe, expect, it } from 'vitest';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { createAuthMutationService, type IssueAuthSessionCommand } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

import { createResilience, readEntries, TestResourceInbox, TestResourceInboxResults, waitForQueuedEntry } from './app-auth-inbox-test-harness.ts';
describe('AppAuthInboxService architecture', () => {
    it('commits issued session, durable result, and completion in one AppInbox transaction', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const credentialSecret = 'test-auth-secret-0123456789abcdef-extra';
        const credentialIssuer = createHmacAuthCredentialIssuer(credentialSecret);
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository: runtime,
        });
        const service = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createAuthMutationService({
                runtimeRepository: runtime,
                serviceId: 'auth-test-service',
            }),
            credentialIssuer,
            'auth-test-service',
        );
        const accessToken = await credentialIssuer.issueAccessToken('session-1');
        const command: IssueAuthSessionCommand = {
            version: 1,
            kind: 'issue-session',
            requestId: 'issue-session-1',
            capturedAtEpochMs: 1_000,
            authority: {
                kind: 'static-client',
                clientId: 'client-1',
                normalizedUsername: 'alice',
            },
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessTokenDigest: await hashAuthSecret(accessToken),
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: Date.now() + 60_000,
            },
        };

        const pending = service.processAuthCommandUntilCompletion(command);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const result = await pending;
        expect(result.right).toMatchObject({
            accessToken,
            sessionId: 'session-1',
        });
        expect(await new AuthSessionRepository(runtime).findByAccessToken(accessToken))
            .toMatchObject({ sessionId: 'session-1' });
        expect(await new AuthSessionRepository(runtime).findBySessionId('session-1'))
            .toMatchObject({
                sessionId: 'session-1',
                accessTokenDigest: command.session.accessTokenDigest,
            });
        const entries = await readEntries(queue);
        expect(entries).toHaveLength(1);
        expect(entries[0].status).toBe(EntityStatus.COMPLETED);
        expect(entries[0].resource).not.toContain(accessToken);
        expect(entries[0].resource).not.toContain(credentialSecret);
        const resultEntry = await results.findByKey(entries[0].key);
        expect(resultEntry?.resource).not.toContain(accessToken);
        expect(resultEntry?.resource).not.toContain(credentialSecret);
        expect(resultEntry?.resource).toContain(command.session.accessTokenDigest);
    });

    it('denies registered-user session issuance when the user is disabled after enqueue', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'disabled-user-secret-0123456789abcdef',
        );
        const service = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
            createAuthMutationService({
                runtimeRepository: runtime,
                serviceId: 'auth-test-service',
            }),
            credentialIssuer,
            'auth-test-service',
        );
        const user = {
            clientId: 'client-disabled',
            username: 'disabled-user',
            normalizedUsername: 'disabled-user',
            displayName: null,
            passwordHash: 'password-hash',
            passwordSalt: 'password-salt',
            passwordAlgorithm: 'pbkdf2-sha256' as const,
            passwordIterations: 120_000,
            roles: ['member'],
            status: 'active' as const,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000,
        };
        await new AuthUserRepository(runtime).putUser(user);
        const pending = service.issueSession({
            requestId: 'disabled-session-request',
            capturedAtEpochMs: 2_000,
            clientId: user.clientId,
            username: user.username,
            sessionId: 'disabled-session',
            expiresAtEpochMs: Date.now() + 60_000,
            authority: {
                kind: 'registered-user',
                clientId: user.clientId,
                normalizedUsername: user.normalizedUsername,
                userRevision: 0,
            },
        } as never);
        await waitForQueuedEntry(queue);
        await new AuthUserRepository(runtime).putUser({
            ...user,
            status: 'disabled',
            updatedAtEpochMs: 1_001,
        });
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const result = await pending;
        expect(result.left).toMatchObject({ status: 403 });
        expect(await new AuthSessionRepository(runtime).findBySessionId('disabled-session'))
            .toBeUndefined();
    });

    it('rereads registered-user policy after a conflict is released for retry', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const users = new AuthUserRepository(runtime);
        const user = {
            clientId: 'client-retry-disabled',
            username: 'retry-disabled',
            normalizedUsername: 'retry-disabled',
            displayName: null,
            passwordHash: 'password-hash',
            passwordSalt: 'password-salt',
            passwordAlgorithm: 'pbkdf2-sha256' as const,
            passwordIterations: 120_000,
            roles: ['member'],
            status: 'active' as const,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000,
        };
        await users.putUser(user);
        let conflictInjected = false;
        let rollbackCount = 0;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                !conflictInjected && operation === 'insertIfAbsent' &&
                namespace === 'auth-sessions:by-token'
            ) {
                conflictInjected = true;
                await runtime.upsert(
                    namespace,
                    key,
                    JSON.stringify({ collision: true }),
                    Date.now() + 60_000,
                );
            }
        };
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository: runtime,
            onTransactionRollback: () => {
                rollbackCount += 1;
            },
        });
        const service = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            database,
            createAuthMutationService({
                runtimeRepository: runtime,
                serviceId: 'auth-test-service',
            }),
            createHmacAuthCredentialIssuer(
                'retry-disabled-secret-0123456789abcdef',
            ),
            'auth-test-service',
        );
        const userRead = vi.spyOn(runtime, 'findEntry');
        const pending = service.issueSession({
            requestId: 'retry-disabled-session-request',
            capturedAtEpochMs: 2_000,
            clientId: user.clientId,
            username: user.username,
            sessionId: 'retry-disabled-session',
            expiresAtEpochMs: Date.now() + 60_000,
            authority: {
                kind: 'registered-user',
                clientId: user.clientId,
                normalizedUsername: user.normalizedUsername,
                userRevision: 0,
            },
        });
        await waitForQueuedEntry(queue);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(100),
        );
        const [releasedForRetry] = await readEntries(queue);
        expect(releasedForRetry).toMatchObject({
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 1 },
        });
        await users.putUser({
            ...user,
            status: 'disabled',
            updatedAtEpochMs: 1_001,
        });
        await new Promise((resolve) => setTimeout(resolve, 110));
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        const result = await pending;
        const policyReads = userRead.mock.calls.filter(([namespace]) =>
            namespace === 'auth-users:by-username' ||
            namespace === 'auth-users:by-client-id'
        );
        expect(result.left).toMatchObject({ status: 403 });
        expect(conflictInjected).toBe(true);
        expect(rollbackCount).toBe(1);
        expect(policyReads).toHaveLength(4);
        const [failed] = await readEntries(queue);
        expect(failed).toMatchObject({
            status: EntityStatus.FAILED,
            dequeueAudit: { attempts: 2 },
        });
        expect(results.allEntries()).toEqual([
            expect.objectContaining({
                status: EntityStatus.FAILED,
                resource: expect.stringContaining('auth-mutation-rejected'),
            }),
        ]);
        expect(results.allEntries()[0]?.resource).not.toContain('session-issued');
        expect([...runtime.data.keys()].filter((key) =>
            key.startsWith('auth-sessions:by-token:') ||
            key.startsWith('auth-sessions:by-session:')
        )).toEqual([]);
        expect(
            await new AuthSessionRepository(runtime).findBySessionId(
                'retry-disabled-session',
            ),
        ).toBeUndefined();
    });

});
