import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
    CircuitBreakerPolicy,
} from '@shared/resilience/Resilience.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import {
    AUTH_STATE_APP_INBOX_TOPIC,
    AppAuthInboxService,
} from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import {
    captureAuthMutationFacts,
    createAuthMutationService,
    decodeAuthMutationCommand,
    type IssueAuthSessionCommand,
    type IssueAuthWsTicketCommand,
    type ConsumeAuthWsTicketCommand,
} from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import {
    createHmacAuthCredentialIssuer,
} from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

const AUTH_INBOX_TYPES = [
    'AUTH_USER_REGISTER',
    'AUTH_SESSION_ISSUE',
    'AUTH_SESSION_LOGOUT',
    'AUTH_WS_TICKET_ISSUE',
    'AUTH_WS_TICKET_CONSUME',
    'AUTH_AGENT_SESSION_TICKETS_ISSUE',
    'AUTH_AGENT_SESSION_TICKET_CONSUME',
] as const;

describe('AppAuthInboxService architecture', () => {
    it('defines every mandatory auth mutation command at the AppInbox boundary', () => {
        expect(AUTH_INBOX_TYPES.map((type) => AppInboxType[type])).toEqual(
            AUTH_INBOX_TYPES,
        );
    });

    it('allows exactly one websocket-ticket consumer without a domain lock', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtime);
        const expiresAtEpochMs = Date.now() + 60_000;
        await repository.putSession({
            clientId: 'client-1',
            accessToken: 'access-token-plaintext',
            username: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs: Date.now(),
            expiresAtEpochMs,
        });
        await repository.putWebSocketTicket({
            ticket: 'presented-ticket-plaintext',
            clientId: 'client-1',
            sessionId: 'session-1',
            issuedAtEpochMs: Date.now(),
            expiresAtEpochMs,
        });

        const results = await Promise.all([
            repository.consumeWebSocketTicket('presented-ticket-plaintext'),
            repository.consumeWebSocketTicket('presented-ticket-plaintext'),
        ]);

        expect(results.filter((result) => result !== undefined)).toHaveLength(1);
        expect(runtime.locks).toEqual([]);
    });

    it('persists only ticket digests and canonical ticket records', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtime);
        await repository.putSession({
            clientId: 'client-1',
            accessToken: 'access-token-plaintext',
            username: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: Date.now() + 60_000,
        });
        await repository.putWebSocketTicket({
            ticket: 'presented-ticket-plaintext',
            clientId: 'client-1',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: Date.now() + 60_000,
        });

        const persisted = [...runtime.data.values()]
            .map((entry) => `${entry.key}:${entry.value}`)
            .join('\n');
        expect(persisted).not.toContain('presented-ticket-plaintext');
    });

    it('removes auth and AL domain-lock escape hatches from production', () => {
        const sources = [
            'packages/shared-server/rallar-system/services/auth-login-service.ts',
            'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
            'packages/shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts',
            'packages/shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts',
            'packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts',
            'packages/shared-server/runtime-state/RuntimeStateRepository.ts',
        ].map((path) => readFileSync(path, 'utf8')).join('\n');

        expect(sources).not.toMatch(/lockKey|pg_advisory_xact_lock/u);
    });

    it('keeps auth compute deterministic and free of credential derivation', () => {
        const source = readFileSync(
            'packages/shared-server/rallar-system/services/auth-state-mutations.ts',
            'utf8',
        );
        const compute = source.slice(
            source.indexOf('function computeAuthMutation('),
            source.indexOf('function validateAuthMutation('),
        );

        expect(compute).not.toMatch(/credentialIssuer|hashAuthSecret|crypto\./u);
        expect(compute).not.toMatch(/^async function computeAuthMutation/mu);
    });

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
        const legacyAccessToken = 'legacy-access-token-plaintext';
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

    it('requires the configured HMAC secret to stay stable for ticket result replay', async () => {
        const first = createHmacAuthCredentialIssuer(
            'first-auth-secret-0123456789abcdef-extra',
        );
        const second = createHmacAuthCredentialIssuer(
            'second-auth-secret-0123456789abcdef-extra',
        );
        const firstTicket = await first.issueWebSocketTicket('request-1', 'session-1');
        const secondTicket = await second.issueWebSocketTicket('request-1', 'session-1');
        expect(firstTicket).not.toBe(secondTicket);
        expect(() => createHmacAuthCredentialIssuer('short-secret'))
            .toThrow(/at least 32 characters/u);
    });

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
        expect((await service.issueWebSocketTicket({
            requestId: 'ws-issue-request',
            capturedAtEpochMs: now + 2,
            session,
            expiresAtEpochMs: now + 30_000,
        })).right).toEqual(wsTicket.right);
        expect((await service.issueWebSocketTicket({
            requestId: 'ws-issue-request',
            capturedAtEpochMs: now + 2,
            session,
            expiresAtEpochMs: now + 30_001,
        })).left?.status).toBe(409);
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
        expect((await service.issueAgentSessionTickets({
            ...agentIssueInput,
            ticketExpiresAtEpochMs: now + 30_001,
        })).left?.status).toBe(409);
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

        const issued = await runAuthCommand(service.issueAgentSessionTickets({
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
        }), queue, reader, 1);

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

    it('selects one CAS winner for concurrent username creation and ticket consumption', async () => {
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
        expect(registrationResults.filter((result) => result.right !== undefined)).toHaveLength(1);
        expect(registrationResults.filter((result) => result.left?.status === 409)).toHaveLength(1);

        const issuedAtEpochMs = now + 1;
        const login = await runAuthCommand(service.issueSession({
            requestId: 'ticket-race-session',
            capturedAtEpochMs: issuedAtEpochMs,
            clientId: 'client-a',
            username: 'same-user',
            sessionId: 'ticket-race-session',
            expiresAtEpochMs: now + 60_000,
        }), queue, reader, 3);
        const session = { ...login.right!, issuedAtEpochMs };
        const issuedTicket = await runAuthCommand(service.issueWebSocketTicket({
            requestId: 'ticket-race-issue',
            capturedAtEpochMs: now + 2,
            session,
            expiresAtEpochMs: now + 30_000,
        }), queue, reader, 4);
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
    }, 15_000);

    it('strictly rejects plaintext or extra auth command fields', () => {
        expect(() => decodeAuthMutationCommand({
            version: 1,
            kind: 'consume-agent-ticket',
            requestId: 'consume-1',
            capturedAtEpochMs: 1_000,
            ticketDigest: 'digest',
            ticket: 'plaintext',
        })).toThrow(/fields|plaintext/u);
    });
});

class TestResourceInbox extends InMemoryQueueBox {
    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry;
    }

    allEntries(): ResourceEntry[] {
        return [...this.data.values()];
    }
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}

async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key)),
    );
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

async function waitForQueuedEntry(
    queue: InMemoryQueueBox,
    minimumEntries = 1,
): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await queue.getAllKeys()).length >= minimumEntries) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('Auth AppInbox test entry was not enqueued');
}

async function runAuthCommand<R>(
    pending: Promise<{ readonly left?: unknown; readonly right?: R }>,
    queue: InMemoryQueueBox,
    reader: InboxQueueReader,
    minimumEntries: number,
): Promise<{ readonly left?: unknown; readonly right?: R }> {
    await waitForQueuedEntry(queue, minimumEntries);
    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    return await pending;
}
