import { describe, expect, it } from 'vitest';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
import {
    createResilience,
    readEntries,
    TestResourceInbox,
    TestResourceInboxResults,
    waitForQueuedEntry,
} from './app-auth-inbox-test-harness.ts';
import {
    createClientStatePhaseTestDriver,
    failNextClientStateTestOutboxWrite,
} from './client-state-phase-test-driver.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('AppInbox expired row replacement', () => {
    it('replaces an expired client session by CAS and rolls back a later failure', async () => {
        const nowEpochMs = 10_000;
        const runtime = new FakeRuntimeStateRepository();
        const service = createClientStatePhaseTestDriver(runtime, () => nowEpochMs);
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            requestId: 'seed-principal',
        });
        await service.upsertInstance(SCOPE, 'alice', 'browser', {
            platform: 'web',
            requestId: 'seed-instance',
        });
        await service.connectSession(SCOPE, 'alice', 'browser', 'session-1', {
            generationId: 'generation-1',
            connectedAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 1_000,
            requestId: 'seed-session',
        });
        const [seeded] = await runtime.findAllEntries('client-state:sessions');
        if (!seeded) throw new Error('Expected seeded client session');
        await runtime.upsert(
            'client-state:sessions',
            seeded.key,
            seeded.value,
            nowEpochMs - 1,
        );
        const expired = await runtime.findEntry('client-state:sessions', seeded.key);
        expect(expired?.revision).toBe(seeded.revision + 1);
        await expect(new ClientStateRepository(runtime).findSession({
            ...SCOPE,
            principalId: 'alice',
            clientInstanceId: 'browser',
            sessionId: 'session-1',
        })).resolves.toBeUndefined();

        failNextClientStateTestOutboxWrite(runtime);
        const replacement = {
            generationId: 'generation-2',
            connectedAtEpochMs: nowEpochMs,
            expiresAtEpochMs: nowEpochMs + 2_000,
            requestId: 'replace-session',
        };
        await expect(service.connectSession(
            SCOPE,
            'alice',
            'browser',
            'session-1',
            replacement,
        )).rejects.toThrow(/outbox collision/u);
        expect(await runtime.findEntry('client-state:sessions', seeded.key))
            .toEqual(expired);
        await service.connectSession(
            SCOPE,
            'alice',
            'browser',
            'session-1',
            replacement,
        );

        const replaced = await runtime.findEntry('client-state:sessions', seeded.key);
        expect(replaced).toMatchObject({ revision: expired!.revision + 1 });
        expect(JSON.parse(replaced!.value)).toMatchObject({
            generationId: 'generation-2',
            generationVersion: 1,
        });
    });

    it('atomically replaces both expired auth session indexes after a CAS conflict', async () => {
        const nowEpochMs = Date.now();
        const runtime = new FakeRuntimeStateRepository();
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'expired-auth-secret-0123456789abcdef',
        );
        let rollbackCount = 0;
        let rollbackPreservedExpiredIndexes = false;
        const service = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results, {
                runtimeRepository: runtime,
                onTransactionRollback: async () => {
                    rollbackCount += 1;
                    const rolledBack = await Promise.all([
                        runtime.findAllEntries('auth-sessions:by-token'),
                        runtime.findAllEntries('auth-sessions:by-session'),
                    ]);
                    rollbackPreservedExpiredIndexes = rolledBack[0][0]?.revision === 0 &&
                        rolledBack[1][0]?.revision === 0;
                },
            }),
            createAuthMutationService({
                runtimeRepository: runtime,
                serviceId: 'expired-auth-service',
            }),
            credentialIssuer,
            'expired-auth-service',
        );
        const accessToken = await credentialIssuer.issueAccessToken('session-1');
        const accessTokenDigest = await hashAuthSecret(accessToken);
        const oldSession = {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest,
            issuedAtEpochMs: nowEpochMs - 10_000,
            expiresAtEpochMs: nowEpochMs - 1,
        };
        const sessions = new AuthSessionRepository(runtime);
        await sessions.insertSessionByTokenDigest(oldSession);
        await sessions.insertSessionBySessionId(oldSession);
        const before = await Promise.all([
            runtime.findAllEntries('auth-sessions:by-token'),
            runtime.findAllEntries('auth-sessions:by-session'),
        ]);
        expect(before[0][0]?.revision).toBe(0);
        expect(before[1][0]?.revision).toBe(0);

        let conflictInjected = false;
        runtime.beforeConditionalWrite = async (operation, namespace, key) => {
            if (
                !conflictInjected && operation === 'upsertIfRevision' &&
                namespace === 'auth-sessions:by-session'
            ) {
                conflictInjected = true;
                const current = await runtime.findEntry(namespace, key);
                if (!current) throw new Error('Expected expired auth session index');
                await runtime.upsert(
                    namespace,
                    key,
                    current.value,
                    current.expireAtTimestamp,
                );
            }
        };
        const pending = service.issueSession({
            requestId: 'replace-expired-auth-session',
            capturedAtEpochMs: nowEpochMs,
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: nowEpochMs + 60_000,
            authority: {
                kind: 'static-client',
                clientId: 'client-1',
                normalizedUsername: 'alice',
            },
        });
        await waitForQueuedEntry(queue);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(1),
        );
        const [afterFirstDequeue] = await readEntries(queue);
        if (afterFirstDequeue?.status === EntityStatus.RETRY) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            await reader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createResilience(),
            );
        }
        await expect(pending).resolves.toMatchObject({
            right: { sessionId: 'session-1', accessToken },
        });
        const after = await Promise.all([
            runtime.findAllEntries('auth-sessions:by-token'),
            runtime.findAllEntries('auth-sessions:by-session'),
        ]);
        expect(after[0][0]?.revision).toBe(1);
        expect(after[1][0]?.revision).toBe(1);
        expect(rollbackCount).toBe(1);
        expect(rollbackPreservedExpiredIndexes).toBe(true);
        expect((await readEntries(queue))[0]).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 2 },
        });
    });
});
