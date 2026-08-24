import { describe, expect, it, vi } from 'vitest';

import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { createAuthInboxTestResilience, TestResourceInbox, TestResourceInboxResults, waitForAuthInboxEntry } from './auth-app-inbox-test-runtime.ts';

it('fails closed without consuming corrupt digest-key ticket rows', async () => {
    const cases = [
        {
            namespace: 'auth-sessions:ws-tickets',
            consume: (repository: AuthSessionRepository, ticket: string) => repository.consumeWebSocketTicket(ticket),
            record: (digest: string, now: number) => ({
                ticketDigest: digest,
                accessTokenDigest: 'access-digest',
                sessionId: 'session-1',
                clientId: 'client-1',
                issuedAtEpochMs: now,
                expiresAtEpochMs: now + 1_000
            })
        },
        {
            namespace: 'auth-sessions:agent-session-tickets',
            consume: (repository: AuthSessionRepository, ticket: string) => repository.consumeAgentSessionTicket(ticket),
            record: (digest: string, now: number) => ({
                ticketDigest: digest,
                accessTokenDigest: 'access-digest',
                sessionId: 'session-1',
                clientId: 'client-1',
                agentId: 'agent-1',
                issuedAtEpochMs: now,
                expiresAtEpochMs: now + 1_000
            })
        }
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
            await runtime.upsert(testCase.namespace, key, JSON.stringify(value), Date.now() + 60_000);

            await expect(testCase.consume(repository, presented)).rejects.toThrow(TypeError);
            expect(await runtime.findEntry(testCase.namespace, key)).toBeDefined();
        }
    }
});

it('preserves normal empty outcomes for current auth storage', preservesCurrentAuthOutcomes);

async function preservesCurrentAuthOutcomes(): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    try {
        const capturedAtEpochMs = Date.now();
        const session = createCurrentSession(capturedAtEpochMs);
        await expectCurrentSessionOutcomes(session);
        await expectCurrentConsumeOutcomes();
    }
    finally {
        vi.useRealTimers();
    }
}

async function expectCurrentSessionOutcomes(
    session: ReturnType<typeof createCurrentSession>
): Promise<void> {
    await expect(
        runCurrentOperation((service) => service.logoutSession({ requestId: 'current-logout', session }))
    ).resolves.toMatchObject({ right: { loggedOut: true } });
    await expect(
        runCurrentOperation((service) =>
            service.issueWebSocketTicket({
                requestId: 'current-ws-issue',
                session,
                ttlMs: 30_000
            })
        )
    ).resolves.toMatchObject({ left: { status: 401 } });
    await expect(
        runCurrentOperation((service) =>
            service.issueAgentSessionTickets({
                requestId: 'current-agent-issue',
                session,
                ticketTtlMs: 30_000,
                agents: [{ agentId: 'agent-1' }]
            })
        )
    ).resolves.toMatchObject({ left: { status: 401 } });
}

async function expectCurrentConsumeOutcomes(): Promise<void> {
    await expect(
        runCurrentOperation((service) =>
            service.consumeWebSocketTicket({
                requestId: 'current-ws-missing',
                ticket: 'missing-ws-ticket',
                expectedSessionId: 'current-session'
            })
        )
    ).resolves.toMatchObject({ left: { status: 404 } });
    await expect(
        runCurrentOperation((service) =>
            service.consumeAgentSessionTicket({
                requestId: 'current-agent-missing',
                ticket: 'missing-agent-ticket'
            })
        )
    ).resolves.toMatchObject({ left: { status: 404 } });
}

function createCurrentSession(capturedAtEpochMs: number): IssuedAuthSession {
    return {
        clientId: 'current-client',
        accessToken: 'current-access-token',
        username: 'current-user',
        sessionId: 'current-session',
        issuedAtEpochMs: capturedAtEpochMs,
        expiresAtEpochMs: capturedAtEpochMs + 60_000
    };
}

async function runCurrentOperation<Result>(
    operation: (service: AppAuthInboxService) => Promise<Result>
): Promise<Result> {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reader = new InboxQueueReader(queue);
    const runtime = new FakeRuntimeStateRepository();
    const service = new AppAuthInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
            authMutationService: createAuthMutationService({
                runtimeRepository: runtime,
                serviceId: 'current-auth-service'
            }),
            credentialIssuer: createHmacAuthCredentialIssuer('current-auth-secret-0123456789abcdef')
        },
        {
            serviceId: 'current-auth-service'
        }
    );
    const pending = operation(service);
    await waitForAuthInboxEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAuthInboxTestResilience()
    );
    return await pending;
}

it('does not scan or accept explicit predecessor rows after the current', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    try {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtime);
        const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');
        const findEntry = vi.spyOn(runtime, 'findEntry');
        const expiresAtEpochMs = Date.now() + 60_000;
        const token = 'current-predecessor-token';
        await runtime.upsert(
            'auth-sessions:by-token',
            `token=${encodeURIComponent(token)}`,
            JSON.stringify({
                clientId: 'predecessor-client',
                username: 'predecessor-user',
                sessionId: 'predecessor-session',
                accessToken: token,
                issuedAtEpochMs: Date.now(),
                expiresAtEpochMs
            }),
            expiresAtEpochMs
        );
        for (
            const [namespace, ticket, agentId] of [
                ['auth-sessions:ws-tickets', 'predecessor-ws-ticket', undefined],
                ['auth-sessions:agent-session-tickets', 'predecessor-agent-ticket', 'agent-1']
            ] as const
        ) {
            await runtime.upsert(
                namespace,
                `ticket=${encodeURIComponent(ticket)}`,
                JSON.stringify({
                    ticket,
                    sessionId: 'predecessor-session',
                    clientId: 'predecessor-client',
                    ...(agentId ? { agentId } : {}),
                    issuedAtEpochMs: Date.now(),
                    expiresAtEpochMs
                }),
                expiresAtEpochMs
            );
        }

        await expect(repository.findByAccessToken(token)).resolves.toBeUndefined();
        await expect(repository.consumeWebSocketTicket('predecessor-ws-ticket')).resolves.toBeUndefined();
        await expect(
            repository.consumeAgentSessionTicket('predecessor-agent-ticket')
        ).resolves.toBeUndefined();
        expect(page).not.toHaveBeenCalled();
        expect(findEntry).not.toHaveBeenCalledWith(
            'auth-sessions:by-token',
            `token=${encodeURIComponent(token)}`
        );
    }
    finally {
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
        expiresAtEpochMs
    });
    await repository.putWebSocketTicket({
        ticket: 'presented-ticket-plaintext',
        clientId: 'client-1',
        sessionId: 'session-1',
        issuedAtEpochMs: Date.now(),
        expiresAtEpochMs
    });

    const results = await Promise.all([
        repository.consumeWebSocketTicket('presented-ticket-plaintext'),
        repository.consumeWebSocketTicket('presented-ticket-plaintext')
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
        expiresAtEpochMs: Date.now() + 60_000
    });
    await repository.putWebSocketTicket({
        ticket: 'presented-ticket-plaintext',
        clientId: 'client-1',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    });

    const persisted = [...runtime.data.values()]
        .map((entry) => `${entry.key}:${entry.value}`)
        .join('\n');
    expect(persisted).not.toContain('presented-ticket-plaintext');
});
