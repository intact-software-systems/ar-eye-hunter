import { describe, expect, it } from 'vitest';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { captureAuthMutationFacts, type ConsumeAuthWsTicketCommand, createAuthMutationService } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

import { createResilience, runAuthCommand, TestResourceInbox, TestResourceInboxResults, waitForQueuedEntry } from './app-auth-inbox-test-harness.ts';
describe('AppAuthInboxService architecture', () => {
    it('rejects a corrupted websocket ticket before deleting it', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const sessions = new AuthSessionRepository(runtime);
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'ws-corruption-secret-0123456789abcdef-extra',
        );
        const now = Date.now();
        const session = {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessToken: await credentialIssuer.issueAccessToken('session-1'),
            issuedAtEpochMs: now - 1,
            expiresAtEpochMs: now + 60_000,
        };
        await sessions.putSession(session);
        const ticket = await credentialIssuer.issueWebSocketTicket(
            'ws-corrupt-consume',
            session.sessionId,
        );
        const ticketDigest = await hashAuthSecret(ticket);
        await sessions.insertWebSocketTicket({
            ticketDigest,
            accessTokenDigest: await hashAuthSecret('wrong-access-token'),
            sessionId: session.sessionId,
            clientId: session.clientId,
            issuedAtEpochMs: now,
            expiresAtEpochMs: now + 30_000,
        });
        const command: ConsumeAuthWsTicketCommand = {
            version: 1,
            kind: 'consume-ws-ticket',
            requestId: 'ws-corrupt-consume',
            capturedAtEpochMs: now + 1,
            ticketDigest,
            expectedSessionId: session.sessionId,
        };
        const service = createAuthMutationService({
            runtimeRepository: runtime,
            serviceId: 'auth-test-service',
        });
        const read = await service.read(command);
        const computed = service.compute(
            command,
            read,
            await captureAuthMutationFacts(command, credentialIssuer),
        );

        expect(() => service.validate(command, read, computed))
            .toThrow(/authority|token/u);
        expect(await sessions.findWebSocketTicketByDigestEntry(ticketDigest))
            .toBeDefined();
    });

    it(
        'selects one CAS winner for concurrent username creation and ticket consumption',
        async () => {
            const queue = new TestResourceInbox();
            const results = new TestResourceInboxResults();
            const reader = new InboxQueueReader(queue);
            const runtime = new FakeRuntimeStateRepository();
            const credentialIssuer = createHmacAuthCredentialIssuer(
                'concurrent-auth-secret-0123456789abcdef',
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
            const now = Date.now();
            const user = {
                username: 'same-user',
                normalizedUsername: 'same-user',
                displayName: null,
                passwordHash: 'password-hash',
                passwordSalt: 'password-salt',
                passwordAlgorithm: 'pbkdf2-sha256' as const,
                passwordIterations: 120_000,
                roles: ['member'],
                status: 'active' as const,
                createdAtEpochMs: now,
                updatedAtEpochMs: now,
            };
            const registrations = [
                service.registerUser({
                    requestId: 'register-race-a',
                    capturedAtEpochMs: now,
                    user: { ...user, clientId: 'client-a' },
                }),
                service.registerUser({
                    requestId: 'register-race-b',
                    capturedAtEpochMs: now,
                    user: { ...user, clientId: 'client-b' },
                }),
            ];
            await waitForQueuedEntry(queue, 2);
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            const registrationResults = await Promise.all(registrations);
            expect(registrationResults.filter((result) => result.right !== undefined)).toHaveLength(
                1,
            );
            expect(registrationResults.filter((result) => result.left?.status === 409))
                .toHaveLength(1);

            const issuedAtEpochMs = now + 1;
            const login = await runAuthCommand(
                service.issueSession({
                    requestId: 'ticket-race-session',
                    capturedAtEpochMs: issuedAtEpochMs,
                    clientId: 'client-a',
                    username: 'same-user',
                    authority: {
                        kind: 'registered-user',
                        clientId: 'client-a',
                        normalizedUsername: 'same-user',
                        userRevision: 0,
                    },
                    sessionId: 'ticket-race-session',
                    expiresAtEpochMs: now + 60_000,
                }),
                queue,
                reader,
                3,
            );
            const session = { ...login.right!, issuedAtEpochMs };
            const issuedTicket = await runAuthCommand(
                service.issueWebSocketTicket({
                    requestId: 'ticket-race-issue',
                    capturedAtEpochMs: now + 2,
                    session,
                    expiresAtEpochMs: now + 30_000,
                }),
                queue,
                reader,
                4,
            );
            const ticket = issuedTicket.right!.ticket;
            const consumes = [
                service.consumeWebSocketTicket({
                    requestId: 'ticket-race-consume-a',
                    capturedAtEpochMs: now + 3,
                    expectedSessionId: session.sessionId,
                    ticket,
                }),
                service.consumeWebSocketTicket({
                    requestId: 'ticket-race-consume-b',
                    capturedAtEpochMs: now + 3,
                    expectedSessionId: session.sessionId,
                    ticket,
                }),
            ];
            await waitForQueuedEntry(queue, 6);
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
            const consumeResults = await Promise.all(consumes);
            expect(consumeResults.filter((result) => result.right !== undefined)).toHaveLength(1);
            expect(consumeResults.filter((result) => result.left?.status === 404)).toHaveLength(1);
            expect(runtime.locks).toEqual([]);
        },
        15_000,
    );
});
