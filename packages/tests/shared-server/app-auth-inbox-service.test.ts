import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
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
import {
    AuthSessionRepository,
    decodePersistedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import {
    AppAuthInboxService,
    AUTH_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import {
    captureAuthMutationFacts,
    type ConsumeAuthWsTicketCommand,
    createAuthMutationService,
    decodeAuthMutationCommand,
    decodeAuthMutationResult,
    type IssueAuthSessionCommand,
    type IssueAuthWsTicketCommand,
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

    it('strictly decodes token-free persisted auth sessions', () => {
        const persisted = {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest: 'digest-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000,
        };
        expect(decodePersistedAuthSession(persisted)).toEqual(persisted);
        for (
            const invalid of [
                { ...persisted, accessToken: 'plaintext-token' },
                { ...persisted, credentialSeed: 'reconstructable' },
                { ...persisted, accessTokenDigest: 12 },
                { ...persisted, expiresAtEpochMs: Number.POSITIVE_INFINITY },
                Object.fromEntries(
                    Object.entries(persisted).filter(([key]) => key !== 'accessTokenDigest'),
                ),
            ]
        ) {
            expect(() => decodePersistedAuthSession(invalid)).toThrow(TypeError);
        }
    });

    it('rejects malformed legacy plaintext session rows instead of widening them', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtime);
        const expiresAtEpochMs = Date.now() + 60_000;
        const accessToken = 'legacy-malformed-token';
        const malformed = JSON.stringify({
            clientId: 'legacy-client',
            username: 'legacy-user',
            sessionId: 'legacy-malformed-session',
            accessToken,
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
            credentialSeed: 'unexpected-reconstruction-material',
        });
        await runtime.upsert(
            'auth-sessions:by-session',
            'session=legacy-malformed-session',
            malformed,
            expiresAtEpochMs,
        );
        await runtime.upsert(
            'auth-sessions:by-token',
            `token=${encodeURIComponent(accessToken)}`,
            malformed,
            expiresAtEpochMs,
        );

        await expect(repository.findBySessionId('legacy-malformed-session'))
            .rejects.toThrow(TypeError);
        await expect(repository.findByAccessToken(accessToken))
            .rejects.toThrow(TypeError);
        await expect(repository.findLegacySessionByAccessTokenDigestEntry(
            await hashAuthSecret(accessToken),
        )).rejects.toThrow(TypeError);
    });

    it('strictly decodes every durable auth result variant', () => {
        const valid = [
            {
                clientId: 'client-1',
                username: 'alice',
                displayName: null,
                registeredAtEpochMs: 1_000,
            },
            { loggedOut: true },
            {
                kind: 'session-issued',
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessTokenDigest: 'digest-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000,
            },
            {
                kind: 'ws-ticket-issued',
                ticketDigest: 'ticket-digest',
                sessionId: 'session-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000,
            },
            {
                kind: 'ws-ticket-consumed',
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessTokenDigest: 'digest-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000,
            },
            {
                kind: 'agent-ticket-consumed',
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessTokenDigest: 'digest-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000,
            },
            {
                kind: 'agent-tickets-issued',
                tickets: [{
                    agentId: 'agent-1',
                    ticketDigest: 'ticket-digest',
                    sessionId: 'agent-session-1',
                    issuedAtEpochMs: 1_000,
                    expiresAtEpochMs: 2_000,
                }],
            },
        ];
        for (const result of valid) {
            expect(decodeAuthMutationResult(result)).toEqual(result);
        }
        for (
            const invalid of [
                { ...valid[2], accessToken: 'plaintext-token' },
                { ...valid[2], unexpected: true },
                {
                    kind: 'agent-tickets-issued',
                    tickets: [{ ...valid[6].tickets![0], ticket: 'x' }],
                },
                { kind: 'agent-tickets-issued', tickets: [null] },
                { ...valid[3], expiresAtEpochMs: Number.NaN },
                Object.create({ kind: 'session-issued' }),
            ]
        ) {
            expect(() => decodeAuthMutationResult(invalid)).toThrow(TypeError);
        }
    });

    it('requires an exact registered-user authority on session issuance commands', () => {
        const command = {
            version: 1,
            kind: 'issue-session',
            requestId: 'session-authority-command',
            capturedAtEpochMs: 1_000,
            authority: {
                kind: 'registered-user',
                clientId: 'client-1',
                normalizedUsername: 'alice',
                userRevision: 3,
            },
            session: {
                clientId: 'client-1',
                username: 'Alice',
                sessionId: 'session-1',
                accessTokenDigest: 'digest-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000,
            },
        } as const;

        expect(decodeAuthMutationCommand(command)).toEqual(command);
        expect(() =>
            decodeAuthMutationCommand({
                ...command,
                authority: {
                    kind: 'registered-user',
                    clientId: 'client-1',
                    normalizedUsername: 'alice',
                },
            })
        ).toThrow(TypeError);
    });

    it('binds session issuance lifecycle to the durable command timestamp', () => {
        const base = {
            version: 1,
            kind: 'issue-session',
            requestId: 'invalid-session-lifecycle',
            capturedAtEpochMs: 1_000,
            authority: {
                kind: 'static-client',
                clientId: 'client-1',
                normalizedUsername: 'alice',
            },
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'invalid-session',
                accessTokenDigest: 'digest-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000,
            },
        } as const;

        for (
            const session of [
                { ...base.session, issuedAtEpochMs: 999 },
                { ...base.session, issuedAtEpochMs: 1_001 },
                { ...base.session, expiresAtEpochMs: 1_000 },
                { ...base.session, expiresAtEpochMs: 999 },
            ]
        ) {
            expect(() =>
                decodeAuthMutationCommand({
                    ...base,
                    session,
                })
            ).toThrow(/lifecycle/u);
        }
    });

    it('does not persist session or success results for malformed lifecycle commands', async () => {
        const capturedAtEpochMs = Date.now() + 60_000;
        const invalidLifecycles = [
            {
                label: 'backdated',
                issuedAtEpochMs: capturedAtEpochMs - 1,
                expiresAtEpochMs: capturedAtEpochMs + 60_000,
            },
            {
                label: 'future-issued',
                issuedAtEpochMs: capturedAtEpochMs + 1,
                expiresAtEpochMs: capturedAtEpochMs + 60_000,
            },
            {
                label: 'equal-expiry',
                issuedAtEpochMs: capturedAtEpochMs,
                expiresAtEpochMs: capturedAtEpochMs,
            },
            {
                label: 'reversed-expiry',
                issuedAtEpochMs: capturedAtEpochMs,
                expiresAtEpochMs: capturedAtEpochMs - 1,
            },
        ] as const;
        for (const lifecycle of invalidLifecycles) {
            const queue = new TestResourceInbox();
            const results = new TestResourceInboxResults();
            const reader = new InboxQueueReader(queue);
            const runtime = new FakeRuntimeStateRepository();
            const credentialIssuer = createHmacAuthCredentialIssuer(
                'invalid-lifecycle-secret-0123456789abcdef',
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
            const command = {
                version: 1,
                kind: 'issue-session',
                requestId: `invalid-lifecycle-${lifecycle.label}`,
                capturedAtEpochMs,
                authority: {
                    kind: 'static-client',
                    clientId: 'client-1',
                    normalizedUsername: 'alice',
                },
                session: {
                    clientId: 'client-1',
                    username: 'alice',
                    sessionId: `invalid-session-${lifecycle.label}`,
                    accessTokenDigest: await hashAuthSecret(
                        await credentialIssuer.issueAccessToken(
                            `invalid-session-${lifecycle.label}`,
                        ),
                    ),
                    issuedAtEpochMs: lifecycle.issuedAtEpochMs,
                    expiresAtEpochMs: lifecycle.expiresAtEpochMs,
                },
            } as IssueAuthSessionCommand;
            const pending = service.processAuthCommandUntilCompletion(command);
            const firstOutcome = await Promise.race([
                pending.then(
                    (value) => ({ kind: 'settled' as const, value }),
                    (error: unknown) => ({ kind: 'rejected' as const, error }),
                ),
                waitForQueuedEntry(queue).then(() => ({ kind: 'queued' as const })),
            ]);
            let rejected = firstOutcome.kind === 'rejected';
            if (firstOutcome.kind === 'queued') {
                await reader.dequeueInbox(
                    InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    createResilience(),
                );
                try {
                    const result = await pending;
                    rejected = result.right === undefined;
                } catch {
                    rejected = true;
                }
            }

            expect(rejected).toBe(true);
            expect(
                [...runtime.data.keys()].filter((key) =>
                    key.startsWith('auth-sessions:by-token::') ||
                    key.startsWith('auth-sessions:by-session::')
                ),
            ).toEqual([]);
            expect(
                results.allEntries().some((entry) =>
                    entry.status === EntityStatus.COMPLETED ||
                    entry.resource.includes('session-issued')
                ),
            ).toBe(false);
        }
    });

    it('fails closed without consuming corrupt digest-key ticket rows', async () => {
        const cases = [
            {
                namespace: 'auth-sessions:ws-tickets',
                consume: (
                    repository: AuthSessionRepository,
                    ticket: string,
                ) => repository.consumeWebSocketTicket(ticket),
                record: (digest: string, now: number) => ({
                    ticketDigest: digest,
                    accessTokenDigest: 'access-digest',
                    sessionId: 'session-1',
                    clientId: 'client-1',
                    issuedAtEpochMs: now,
                    expiresAtEpochMs: now + 1_000,
                }),
            },
            {
                namespace: 'auth-sessions:agent-session-tickets',
                consume: (
                    repository: AuthSessionRepository,
                    ticket: string,
                ) => repository.consumeAgentSessionTicket(ticket),
                record: (digest: string, now: number) => ({
                    ticketDigest: digest,
                    accessTokenDigest: 'access-digest',
                    sessionId: 'session-1',
                    clientId: 'client-1',
                    agentId: 'agent-1',
                    issuedAtEpochMs: now,
                    expiresAtEpochMs: now + 1_000,
                }),
            },
        ] as const;
        for (const testCase of cases) {
            for (const corruption of ['digest', 'plaintext', 'lifecycle'] as const) {
                const runtime = new FakeRuntimeStateRepository();
                const repository = new AuthSessionRepository(runtime);
                const presented = `${testCase.namespace}-${corruption}`;
                const requestedDigest = await hashAuthSecret(presented);
                const valid = testCase.record(requestedDigest, 1_000);
                const value = corruption === 'digest'
                    ? { ...valid, ticketDigest: 'wrong-digest' }
                    : corruption === 'plaintext'
                    ? { ...valid, ticket: 'plaintext-secret' }
                    : { ...valid, expiresAtEpochMs: valid.issuedAtEpochMs };
                const key = `ticket-digest=${encodeURIComponent(requestedDigest)}`;
                await runtime.upsert(
                    testCase.namespace,
                    key,
                    JSON.stringify(value),
                    Date.now() + 60_000,
                );

                await expect(testCase.consume(repository, presented))
                    .rejects.toThrow(TypeError);
                expect(await runtime.findEntry(testCase.namespace, key)).toBeDefined();
            }
        }
    });

    it('caps legacy plaintext compatibility scans and never falls back to full reads', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const findAll = vi.spyOn(runtime, 'findAllEntries');
        const page = vi.fn(async (
            namespace: string,
            keyPrefix: string,
            options: Readonly<{ afterKey?: string; limit: number }>,
        ) => (await runtime.findEntriesByPrefix(namespace, keyPrefix))
            .filter((entry) => options.afterKey === undefined || entry.key > options.afterKey)
            .slice(0, options.limit)
        );
        Object.assign(runtime, { findEntriesByPrefixPage: page });
        for (let index = 0; index < 300; index += 1) {
            const token = `legacy-token-${String(index).padStart(3, '0')}`;
            await runtime.upsert(
                'auth-sessions:by-token',
                `token=${encodeURIComponent(token)}`,
                JSON.stringify({
                    clientId: `client-${index}`,
                    username: `user-${index}`,
                    sessionId: `session-${index}`,
                    accessToken: token,
                    issuedAtEpochMs: 1_000,
                    expiresAtEpochMs: Date.now() + 60_000,
                }),
                Date.now() + 60_000,
            );
        }

        await expect(new AuthSessionRepository(runtime)
            .findLegacySessionByAccessTokenDigestEntry('missing-digest'))
            .rejects.toThrow(/limit/u);
        expect(findAll).not.toHaveBeenCalled();
        expect(page).toHaveBeenCalledTimes(1);
        expect(page.mock.calls[0]?.[2].limit).toBeLessThanOrEqual(129);
    });

    it('disables direct legacy compatibility at its explicit deadline', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
        try {
            const runtime = new FakeRuntimeStateRepository();
            const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');

            await expect(new AuthSessionRepository(runtime)
                .findLegacySessionByAccessTokenDigestEntry('missing-digest'))
                .resolves.toBeUndefined();
            expect(page).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves normal empty auth outcomes after the legacy cutoff', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
        try {
            const capturedAtEpochMs = Date.now();
            const session = {
                clientId: 'cutoff-client',
                accessToken: 'cutoff-access-token',
                username: 'cutoff-user',
                sessionId: 'cutoff-session',
                issuedAtEpochMs: capturedAtEpochMs,
                expiresAtEpochMs: capturedAtEpochMs + 60_000,
            };
            const run = async (
                operation: (service: AppAuthInboxService) => Promise<unknown>,
            ): Promise<unknown> => {
                const queue = new TestResourceInbox();
                const results = new TestResourceInboxResults();
                const reader = new InboxQueueReader(queue);
                const runtime = new FakeRuntimeStateRepository();
                const service = new AppAuthInboxService(
                    reader,
                    queue as never,
                    results as never,
                    createAppInboxTestDatabase(queue, results, {
                        runtimeRepository: runtime,
                    }),
                    createAuthMutationService({
                        runtimeRepository: runtime,
                        serviceId: 'cutoff-auth-service',
                    }),
                    createHmacAuthCredentialIssuer(
                        'cutoff-auth-secret-0123456789abcdef',
                    ),
                    'cutoff-auth-service',
                );
                const pending = operation(service);
                await waitForQueuedEntry(queue);
                await reader.dequeueInbox(
                    InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    createResilience(),
                );
                return await pending;
            };

            await expect(run((service) =>
                service.logoutSession({
                    requestId: 'cutoff-logout',
                    capturedAtEpochMs,
                    session,
                })
            )).resolves.toMatchObject({ right: { loggedOut: true } });
            await expect(run((service) =>
                service.issueWebSocketTicket({
                    requestId: 'cutoff-ws-issue',
                    capturedAtEpochMs,
                    session,
                    expiresAtEpochMs: capturedAtEpochMs + 30_000,
                })
            )).resolves.toMatchObject({ left: { status: 401 } });
            await expect(run((service) =>
                service.issueAgentSessionTickets({
                    requestId: 'cutoff-agent-issue',
                    capturedAtEpochMs,
                    session,
                    sessionExpiresAtEpochMs: capturedAtEpochMs + 60_000,
                    ticketExpiresAtEpochMs: capturedAtEpochMs + 30_000,
                    agents: [{ agentId: 'agent-1', sessionId: 'agent-session-1' }],
                })
            )).resolves.toMatchObject({ left: { status: 401 } });
            await expect(run((service) =>
                service.consumeWebSocketTicket({
                    requestId: 'cutoff-ws-missing',
                    capturedAtEpochMs,
                    ticket: 'missing-ws-ticket',
                    expectedSessionId: 'cutoff-session',
                })
            )).resolves.toMatchObject({ left: { status: 404 } });
            await expect(run((service) =>
                service.consumeAgentSessionTicket({
                    requestId: 'cutoff-agent-missing',
                    capturedAtEpochMs,
                    ticket: 'missing-agent-ticket',
                })
            )).resolves.toMatchObject({ left: { status: 404 } });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not scan or accept explicit legacy rows after the cutoff', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
        try {
            const runtime = new FakeRuntimeStateRepository();
            const repository = new AuthSessionRepository(runtime);
            const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');
            const findEntry = vi.spyOn(runtime, 'findEntry');
            const expiresAtEpochMs = Date.now() + 60_000;
            const token = 'cutoff-legacy-token';
            await runtime.upsert(
                'auth-sessions:by-token',
                `token=${encodeURIComponent(token)}`,
                JSON.stringify({
                    clientId: 'legacy-client',
                    username: 'legacy-user',
                    sessionId: 'legacy-session',
                    accessToken: token,
                    issuedAtEpochMs: Date.now(),
                    expiresAtEpochMs,
                }),
                expiresAtEpochMs,
            );
            for (
                const [namespace, ticket, agentId] of [
                    ['auth-sessions:ws-tickets', 'legacy-ws-ticket', undefined],
                    ['auth-sessions:agent-session-tickets', 'legacy-agent-ticket', 'agent-1'],
                ] as const
            ) {
                await runtime.upsert(
                    namespace,
                    `ticket=${encodeURIComponent(ticket)}`,
                    JSON.stringify({
                        ticket,
                        sessionId: 'legacy-session',
                        clientId: 'legacy-client',
                        ...(agentId ? { agentId } : {}),
                        issuedAtEpochMs: Date.now(),
                        expiresAtEpochMs,
                    }),
                    expiresAtEpochMs,
                );
            }

            await expect(repository.findByAccessToken(token)).resolves.toBeUndefined();
            await expect(repository.consumeWebSocketTicket('legacy-ws-ticket'))
                .resolves.toBeUndefined();
            await expect(repository.consumeAgentSessionTicket('legacy-agent-ticket'))
                .resolves.toBeUndefined();
            expect(page).not.toHaveBeenCalled();
            expect(findEntry).not.toHaveBeenCalledWith(
                'auth-sessions:by-token',
                `token=${encodeURIComponent(token)}`,
            );
        } finally {
            vi.useRealTimers();
        }
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
            'packages/shared-server/rallar-system/repositories/auth-session-persistence.ts',
            'packages/shared-server/rallar-system/repositories/auth-ticket-persistence.ts',
            'packages/shared-server/rallar-system/repositories/auth-legacy-compatibility.ts',
            'packages/shared-server/postgres/al-runtime/PSqlInboundAdmissionBackend.ts',
            'packages/shared-server/postgres/al-runtime/PSqlOutboundAdmissionBackend.ts',
            'packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts',
            'packages/shared-server/runtime-state/RuntimeStateRepository.ts',
        ].map((path) => readFileSync(path, 'utf8')).join('\n');

        expect(sources).not.toMatch(/lockKey|pg_advisory_xact_lock/u);
    });

    it('keeps auth compute deterministic and free of credential derivation', () => {
        const source = readFileSync(
            'packages/shared-server/rallar-system/services/auth-state-compute.ts',
            'utf8',
        );
        const compute = source.slice(
            source.indexOf('export function computeAuthMutation('),
            source.length,
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

    it('strictly rejects plaintext or extra auth command fields', () => {
        expect(() =>
            decodeAuthMutationCommand({
                version: 1,
                kind: 'consume-agent-ticket',
                requestId: 'consume-1',
                capturedAtEpochMs: 1_000,
                ticketDigest: 'digest',
                ticket: 'plaintext',
            })
        ).toThrow(/fields|plaintext/u);
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

function createResilience(firstRetryDelayMs?: number): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const args = [
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    ] as const;
    if (firstRetryDelayMs === undefined) {
        return ResilienceDto.toResilienceDto(...args);
    }
    return ResilienceDto.toResilienceDto(...args, 10, {
        maxAttempts: 20,
        delaysAfterAttemptMs: [firstRetryDelayMs],
        maxDelayMs: firstRetryDelayMs,
        jitterRatio: 0,
        staleDueThresholdMs: 30_000,
    });
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
