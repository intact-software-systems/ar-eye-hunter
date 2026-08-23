import { describe, expect, it, vi } from 'vitest';

import { requireApiAuthSession, requireWsAuthSession } from '@shared-server/http/request-auth-service.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { Either } from '@shared/resilience/Either.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

it('validates bearer tokens against x-client-id', async () => {
    const repository = new AuthSessionRepository(new FakeRuntimeStateRepository());
    await repository.putSession({
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'alice',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    });

    const authorised = await requireApiAuthSession(
        {
            header(name) {
                return name === 'authorization'
                    ? 'Bearer token-1'
                    : name === 'x-client-id'
                    ? 'client-1'
                    : undefined;
            }
        },
        repository
    );

    expect(authorised.sessionId).toBe('session-1');
    await expect(
        requireApiAuthSession(
            {
                header(name) {
                    return name === 'authorization'
                        ? 'Bearer token-1'
                        : name === 'x-client-id'
                        ? 'client-2'
                        : undefined;
                }
            },
            repository
        )
    ).rejects.toThrow('Unauthorized: Access token does not match x-client-id');
});

it('consumes websocket tickets once and rejects session mismatches', async () => {
    const expiresAtEpochMs = Date.now() + 60_000;
    const session = {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'alice',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs
    };
    const tickets = new Map([
        ['ticket-1', session],
        ['ticket-2', session]
    ]);
    const appAuthInbox = {
        consumeWebSocketTicket: (input: { ticket: string; expectedSessionId: string; }) => {
            const current = tickets.get(input.ticket);
            if (!current || current.sessionId !== input.expectedSessionId) {
                return Promise.resolve(Either.ofLeft({ message: 'invalid' }));
            }
            tickets.delete(input.ticket);
            return Promise.resolve(Either.ofRight(current));
        }
    } as never;

    await expect(
        requireWsAuthSession({ sessionId: 'session-1', ticket: 'ticket-1' }, appAuthInbox, {
            requestId: 'consume-1'
        })
    ).resolves.toMatchObject({ clientId: 'client-1' });

    await expect(
        requireWsAuthSession({ sessionId: 'session-1', ticket: 'ticket-1' }, appAuthInbox, {
            requestId: 'consume-2'
        })
    ).rejects.toThrow('Unauthorized: Invalid or expired websocket auth ticket');

    await expect(
        requireWsAuthSession({ sessionId: 'session-2', ticket: 'ticket-2' }, appAuthInbox, {
            requestId: 'consume-3'
        })
    ).rejects.toThrow('Unauthorized: Invalid or expired websocket auth ticket');
});

it('keeps same-user sessions independent when one session logs out', async () => {
    const repository = new AuthSessionRepository(new FakeRuntimeStateRepository());
    const expiresAtEpochMs = Date.now() + 60_000;
    const sessionA = {
        clientId: 'client-1',
        accessToken: 'token-a',
        username: 'alice',
        sessionId: 'session-a',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs
    };
    const sessionB = {
        clientId: 'client-1',
        accessToken: 'token-b',
        username: 'alice',
        sessionId: 'session-b',
        issuedAtEpochMs: 1_001,
        expiresAtEpochMs
    };
    await repository.putSession(sessionA);
    await repository.putSession(sessionB);
    await repository.putWebSocketTicket({
        ticket: 'ticket-a-before-logout',
        clientId: sessionA.clientId,
        sessionId: sessionA.sessionId,
        issuedAtEpochMs: 1_100,
        expiresAtEpochMs
    });
    await repository.putWebSocketTicket({
        ticket: 'ticket-b-after-logout',
        clientId: sessionB.clientId,
        sessionId: sessionB.sessionId,
        issuedAtEpochMs: 1_101,
        expiresAtEpochMs
    });

    await repository.deleteSession(sessionA);

    await expect(
        requireApiAuthSession(authRequest(sessionA.accessToken, sessionA.clientId), repository)
    ).rejects.toThrow('Unauthorized: Invalid or expired access token');
    await expect(
        requireApiAuthSession(authRequest(sessionB.accessToken, sessionB.clientId), repository)
    ).resolves.toMatchObject({
        clientId: 'client-1',
        sessionId: 'session-b'
    });
});

it('returns the current invalid-bearer denial without scanning unrelated rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    try {
        const runtime = new FakeRuntimeStateRepository();
        const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');
        const repository = new AuthSessionRepository(runtime);

        await expect(
            requireApiAuthSession(authRequest('missing-token', 'client-1'), repository)
        ).rejects.toThrow('Unauthorized: Invalid or expired access token');
        expect(page).not.toHaveBeenCalled();
    }
    finally {
        vi.useRealTimers();
    }
});

function authRequest(
    accessToken: string,
    clientId: string
): {
    header(name: string): string | undefined;
} {
    return {
        header(name) {
            return name === 'authorization'
                ? `Bearer ${accessToken}`
                : name === 'x-client-id'
                ? clientId
                : undefined;
        }
    };
}
