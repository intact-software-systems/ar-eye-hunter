import { describe, expect, it } from 'vitest';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { captureAuthMutationFacts, createAuthMutationService, type IssueAuthWsTicketCommand } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

import { readEntries, runAuthCommand, TestResourceInbox, TestResourceInboxResults } from './app-auth-inbox-test-harness.ts';
describe('AppAuthInboxService architecture', () => {
    it('routes registration, ticket issuance, agent batches, and logout through durable commands', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const secret = 'all-auth-verbs-secret-0123456789abcdef';
        const credentialIssuer = createHmacAuthCredentialIssuer(secret);
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
        const now = Date.now();
        const registered = await runAuthCommand(
            service.registerUser({
                requestId: 'register-request',
                capturedAtEpochMs: now,
                user: {
                    clientId: 'client-registered',
                    username: 'registered-user',
                    normalizedUsername: 'registered-user',
                    displayName: null,
                    passwordHash: 'password-hash',
                    passwordSalt: 'password-salt',
                    passwordAlgorithm: 'pbkdf2-sha256',
                    passwordIterations: 120_000,
                    roles: ['member'],
                    status: 'active',
                    createdAtEpochMs: now,
                    updatedAtEpochMs: now,
                },
            }),
            queue,
            reader,
            1,
        );
        expect(registered.right).toMatchObject({ username: 'registered-user' });

        const login = await runAuthCommand(
            service.issueSession({
                requestId: 'session-request',
                capturedAtEpochMs: now + 1,
                clientId: 'client-registered',
                username: 'registered-user',
                authority: {
                    kind: 'registered-user',
                    clientId: 'client-registered',
                    normalizedUsername: 'registered-user',
                    userRevision: 0,
                },
                sessionId: 'session-registered',
                expiresAtEpochMs: now + 60_000,
            }),
            queue,
            reader,
            2,
        );
        expect(login.right).toBeDefined();
        const session = {
            ...login.right!,
            issuedAtEpochMs: now + 1,
        };
        const wsTicket = await runAuthCommand(
            service.issueWebSocketTicket({
                requestId: 'ws-issue-request',
                capturedAtEpochMs: now + 2,
                session,
                expiresAtEpochMs: now + 30_000,
            }),
            queue,
            reader,
            3,
        );
        expect(wsTicket.right?.ticket).toBeDefined();
        expect(
            (await service.issueWebSocketTicket({
                requestId: 'ws-issue-request',
                capturedAtEpochMs: now + 2,
                session,
                expiresAtEpochMs: now + 30_000,
            })).right,
        ).toEqual(wsTicket.right);
        expect(
            (await service.issueWebSocketTicket({
                requestId: 'ws-issue-request',
                capturedAtEpochMs: now + 2,
                session,
                expiresAtEpochMs: now + 30_001,
            })).left?.status,
        ).toBe(409);
        const agentTickets = await runAuthCommand(
            service.issueAgentSessionTickets({
                requestId: 'agent-issue-request',
                capturedAtEpochMs: now + 3,
                session,
                sessionExpiresAtEpochMs: session.expiresAtEpochMs,
                ticketExpiresAtEpochMs: now + 30_000,
                agents: [
                    { agentId: 'agent-a', sessionId: 'agent-session-a' },
                    { agentId: 'agent-b', sessionId: 'agent-session-b' },
                ],
            }),
            queue,
            reader,
            4,
        );
        expect(agentTickets.right?.tickets).toHaveLength(2);
        const agentIssueInput = {
            requestId: 'agent-issue-request',
            capturedAtEpochMs: now + 3,
            session,
            sessionExpiresAtEpochMs: session.expiresAtEpochMs,
            ticketExpiresAtEpochMs: now + 30_000,
            agents: [
                { agentId: 'agent-a', sessionId: 'agent-session-a' },
                { agentId: 'agent-b', sessionId: 'agent-session-b' },
            ],
        } as const;
        expect((await service.issueAgentSessionTickets(agentIssueInput)).right)
            .toEqual(agentTickets.right);
        expect(
            (await service.issueAgentSessionTickets({
                ...agentIssueInput,
                ticketExpiresAtEpochMs: now + 30_001,
            })).left?.status,
        ).toBe(409);
        const expiredWs = await runAuthCommand(
            service.consumeWebSocketTicket({
                requestId: 'ws-expired-consume',
                capturedAtEpochMs: now + 30_001,
                expectedSessionId: session.sessionId,
                ticket: wsTicket.right!.ticket,
            }),
            queue,
            reader,
            5,
        );
        expect(expiredWs.left?.status).toBe(410);
        const expiredAgent = await runAuthCommand(
            service.consumeAgentSessionTicket({
                requestId: 'agent-expired-consume',
                capturedAtEpochMs: now + 30_001,
                ticket: agentTickets.right!.tickets[0].ticket,
            }),
            queue,
            reader,
            6,
        );
        expect(expiredAgent.left?.status).toBe(410);
        const logout = await runAuthCommand(
            service.logoutSession({
                requestId: 'logout-request',
                capturedAtEpochMs: now + 4,
                session,
            }),
            queue,
            reader,
            7,
        );
        expect(logout.right).toEqual({ loggedOut: true });
        expect(await new AuthSessionRepository(runtime).findBySessionId(session.sessionId))
            .toBeUndefined();
        expect([...database.outboxEntries.values()].map((entry) => entry.typeId))
            .toContain('WS_OUTBOX');

        const plaintext = [
            login.right?.accessToken,
            wsTicket.right?.ticket,
            ...(agentTickets.right?.tickets.map((ticket) => ticket.ticket) ?? []),
            secret,
        ].filter((value): value is string => value !== undefined);
        const durableResources = [
            ...(await readEntries(queue)).map((entry) => entry.resource),
            ...results.allEntries().map((entry) => entry.resource),
        ].join('\n');
        for (const credential of plaintext) {
            expect(durableResources).not.toContain(credential);
        }
    });

    it('rechecks the parent session before issuing agent credentials', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const runtime = new FakeRuntimeStateRepository();
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'agent-authority-secret-0123456789abcdef',
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

        const issued = await runAuthCommand(
            service.issueAgentSessionTickets({
                requestId: 'agent-without-authority',
                capturedAtEpochMs: now,
                session: {
                    clientId: 'absent-client',
                    username: 'absent-user',
                    sessionId: 'absent-session',
                    accessToken: 'absent-access-token',
                    issuedAtEpochMs: now - 1,
                    expiresAtEpochMs: now + 60_000,
                },
                sessionExpiresAtEpochMs: now + 60_000,
                ticketExpiresAtEpochMs: now + 30_000,
                agents: [{ agentId: 'agent-a', sessionId: 'agent-session-a' }],
            }),
            queue,
            reader,
            1,
        );

        expect(issued.left).toMatchObject({ status: 401 });
        expect(await new AuthSessionRepository(runtime).findBySessionId('agent-session-a'))
            .toBeUndefined();
    });

    it('rejects websocket ticket issuance when the presented session token differs', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const sessions = new AuthSessionRepository(runtime);
        const credentialIssuer = createHmacAuthCredentialIssuer(
            'ws-authority-secret-0123456789abcdef-extra',
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
            'ws-wrong-token',
            session.sessionId,
        );
        const command: IssueAuthWsTicketCommand = {
            version: 1,
            kind: 'issue-ws-ticket',
            requestId: 'ws-wrong-token',
            capturedAtEpochMs: now,
            ticketRecord: {
                ticketDigest: await hashAuthSecret(ticket),
                accessTokenDigest: await hashAuthSecret('wrong-access-token'),
                sessionId: session.sessionId,
                clientId: session.clientId,
                issuedAtEpochMs: now,
                expiresAtEpochMs: now + 30_000,
            },
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
    });

});
