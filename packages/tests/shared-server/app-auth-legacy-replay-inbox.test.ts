import { describe, expect, it } from 'vitest';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AppAuthInboxService, AUTH_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import { createAuthMutationService, type IssueAuthSessionCommand } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

import { createResilience, readEntries, TestResourceInbox, TestResourceInboxResults, waitForQueuedEntry } from './app-auth-inbox-test-harness.ts';
describe('AppAuthInboxService architecture', () => {
    it('consumes bounded legacy plaintext ticket rows without queueing their credentials', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'test-auth-secret-0123456789abcdef-extra',
        );
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
        const expiresAtEpochMs = Date.now() + 60_000;
        const legacyAccessToken = await credentialIssuer.issueAccessToken('legacy-session');
        const session = {
            clientId: 'legacy-client',
            username: 'legacy-user',
            sessionId: 'legacy-session',
            accessToken: legacyAccessToken,
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
        };
        await runtime.upsert(
            'auth-sessions:by-token',
            `token=${encodeURIComponent(legacyAccessToken)}`,
            JSON.stringify(session),
            expiresAtEpochMs,
        );
        await runtime.upsert(
            'auth-sessions:by-session',
            'session=legacy-session',
            JSON.stringify(session),
            expiresAtEpochMs,
        );
        const legacyWsTicket = 'legacy-ws-ticket-plaintext';
        const legacyAgentTicket = 'legacy-agent-ticket-plaintext';
        await runtime.upsert(
            'auth-sessions:ws-tickets',
            `ticket=${encodeURIComponent(legacyWsTicket)}`,
            JSON.stringify({
                ticket: legacyWsTicket,
                clientId: session.clientId,
                sessionId: session.sessionId,
                issuedAtEpochMs: 1_001,
                expiresAtEpochMs,
            }),
            expiresAtEpochMs,
        );
        await runtime.upsert(
            'auth-sessions:agent-session-tickets',
            `ticket=${encodeURIComponent(legacyAgentTicket)}`,
            JSON.stringify({
                ticket: legacyAgentTicket,
                clientId: session.clientId,
                sessionId: session.sessionId,
                agentId: 'legacy-agent',
                issuedAtEpochMs: 1_002,
                expiresAtEpochMs,
            }),
            expiresAtEpochMs,
        );

        expect(await new AuthSessionRepository(runtime).findByAccessToken(legacyAccessToken))
            .toMatchObject({ sessionId: session.sessionId });
        const wsPending = service.consumeWebSocketTicket({
            requestId: 'legacy-ws-consume',
            capturedAtEpochMs: Date.now(),
            ticket: legacyWsTicket,
            expectedSessionId: session.sessionId,
        });
        await waitForQueuedEntry(queue);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect((await readEntries(queue)).map((entry) => ({
            key: entry.key,
            status: entry.status,
            next: entry.dequeueAudit.nextTs?.toString(),
        }))).toEqual([{
            key: {
                topicId: AUTH_STATE_APP_INBOX_TOPIC,
                resourceId: 'legacy-ws-consume',
                contextId: session.sessionId,
            },
            status: EntityStatus.COMPLETED,
            next: undefined,
        }]);
        expect((await wsPending).right).toMatchObject({ accessToken: legacyAccessToken });
        const agentPending = service.consumeAgentSessionTicket({
            requestId: 'legacy-agent-consume',
            capturedAtEpochMs: Date.now(),
            ticket: legacyAgentTicket,
        });
        await waitForQueuedEntry(queue, 2);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        expect((await agentPending).right).toMatchObject({ accessToken: legacyAccessToken });

        const durableResources = [
            ...(await readEntries(queue)).map((entry) => entry.resource),
            ...results.allEntries().map((entry) => entry.resource),
        ].join('\n');
        expect(durableResources).not.toContain(legacyAccessToken);
        expect(durableResources).not.toContain(legacyWsTicket);
        expect(durableResources).not.toContain(legacyAgentTicket);
        expect(runtime.data.has(
            `auth-sessions:ws-tickets::ticket=${encodeURIComponent(legacyWsTicket)}`,
        )).toBe(false);
        expect(runtime.data.has(
            `auth-sessions:agent-session-tickets::ticket=${encodeURIComponent(legacyAgentTicket)}`,
        )).toBe(false);
    });

    it('fails durable result replay after the HMAC secret rotates', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const database = createAppInboxTestDatabase(queue, results, {
            runtimeRepository: runtime,
        });
        const firstIssuer = createHmacAuthCredentialIssuer(
            'first-auth-secret-0123456789abcdef-extra',
        );
        const rotatedIssuer = createHmacAuthCredentialIssuer(
            'second-auth-secret-0123456789abcdef-extra',
        );
        const mutationService = createAuthMutationService({
            runtimeRepository: runtime,
            serviceId: 'auth-test-service',
        });
        const firstService = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            database,
            mutationService,
            firstIssuer,
            'auth-test-service',
        );
        const firstAccessToken = await firstIssuer.issueAccessToken('rotation-session');
        const command: IssueAuthSessionCommand = {
            version: 1,
            kind: 'issue-session',
            requestId: 'rotated-secret-replay',
            capturedAtEpochMs: 1_000,
            authority: {
                kind: 'static-client',
                clientId: 'rotation-client',
                normalizedUsername: 'rotation-user',
            },
            session: {
                clientId: 'rotation-client',
                username: 'rotation-user',
                sessionId: 'rotation-session',
                accessTokenDigest: await hashAuthSecret(firstAccessToken),
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: Date.now() + 60_000,
            },
        };
        const firstPending = firstService.processAuthCommandUntilCompletion(command);
        await waitForQueuedEntry(queue);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const firstResult = await firstPending;
        expect(firstResult.right).toBeDefined();

        const rotatedService = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            database,
            mutationService,
            rotatedIssuer,
            'auth-test-service',
        );
        await expect(rotatedService.processAuthCommandUntilCompletion(command))
            .rejects.toThrow(/digest differs/u);
        const durableResources = [
            ...(await readEntries(queue)).map((entry) => entry.resource),
            ...results.allEntries().map((entry) => entry.resource),
        ].join('\n');
        expect(durableResources).not.toContain(firstAccessToken);
        expect(durableResources).not.toContain(
            await rotatedIssuer.issueAccessToken('rotation-session'),
        );
    });

    it('fails closed when durable auth result rows are corrupted', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'corrupted-result-secret-0123456789abcdef',
        );
        const service = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results, {
                runtimeRepository: runtime,
            }),
            createAuthMutationService({
                runtimeRepository: runtime,
                serviceId: 'auth-test-service',
            }),
            credentialIssuer,
            'auth-test-service',
        );
        const accessToken = await credentialIssuer.issueAccessToken('corrupt-session');
        const command: IssueAuthSessionCommand = {
            version: 1,
            kind: 'issue-session',
            requestId: 'corrupt-result-replay',
            capturedAtEpochMs: 1_000,
            authority: {
                kind: 'static-client',
                clientId: 'corrupt-client',
                normalizedUsername: 'corrupt-user',
            },
            session: {
                clientId: 'corrupt-client',
                username: 'corrupt-user',
                sessionId: 'corrupt-session',
                accessTokenDigest: await hashAuthSecret(accessToken),
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: Date.now() + 60_000,
            },
        };
        const pending = service.processAuthCommandUntilCompletion(command);
        await waitForQueuedEntry(queue);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect((await pending).right).toBeDefined();
        const [durableResult] = results.allEntries();
        expect(durableResult).toBeDefined();

        const injectedSecret = 'must-never-appear-in-error';
        for (
            const corrupted of [
                {
                    ...command.session,
                    kind: 'session-issued',
                    accessToken: injectedSecret,
                },
                {
                    clientId: command.session.clientId,
                    username: command.session.username,
                    sessionId: command.session.sessionId,
                    kind: 'session-issued',
                    issuedAtEpochMs: command.session.issuedAtEpochMs,
                    expiresAtEpochMs: command.session.expiresAtEpochMs,
                },
                {
                    ...command.session,
                    kind: 'session-issued',
                    expiresAtEpochMs: 'tomorrow',
                },
            ]
        ) {
            await results.replace({
                ...durableResult!,
                resource: JSON.stringify(corrupted),
            });
            try {
                await service.processAuthCommandUntilCompletion(command);
                throw new Error('Expected corrupted durable auth result to be rejected');
            } catch (error) {
                expect(error).toBeInstanceOf(TypeError);
                expect(String(error)).not.toContain(injectedSecret);
            }
        }
    });

});
