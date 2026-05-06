import { describe, expect, it } from 'vitest';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { requireApiAuthSession, requireWsAuthSession, } from '@shared-server/http/request-auth-service.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('request auth service', () => {
    it('validates bearer tokens against x-client-id', async () => {
        const repository = new AuthSessionRepository(new FakeRuntimeStateRepository());
        await repository.putSession({
            clientId: 'client-1',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: Date.now() + 60_000,
        });

        const authorised = await requireApiAuthSession(
            {
                header(name) {
                    return name === 'authorization'
                        ? 'Bearer token-1'
                        : name === 'x-client-id'
                            ? 'client-1'
                            : undefined;
                },
            },
            repository,
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
                    },
                },
                repository,
            ),
        ).rejects.toThrow('Unauthorized: Access token does not match x-client-id');
    });

    it('consumes websocket tickets once and rejects session mismatches', async () => {
        const repository = new AuthSessionRepository(new FakeRuntimeStateRepository());
        const expiresAtEpochMs = Date.now() + 60_000;
        await repository.putSession({
            clientId: 'client-1',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
        });
        await repository.putWebSocketTicket({
            ticket: 'ticket-1',
            clientId: 'client-1',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
        });
        await repository.putWebSocketTicket({
            ticket: 'ticket-2',
            clientId: 'client-1',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
        });

        await expect(
            requireWsAuthSession(
                { sessionId: 'session-1', ticket: 'ticket-1' },
                repository,
            ),
        ).resolves.toMatchObject({ clientId: 'client-1' });

        await expect(
            requireWsAuthSession(
                { sessionId: 'session-1', ticket: 'ticket-1' },
                repository,
            ),
        ).rejects.toThrow('Unauthorized: Invalid or expired websocket auth ticket');

        await expect(
            requireWsAuthSession(
                { sessionId: 'session-2', ticket: 'ticket-2' },
                repository,
            ),
        ).rejects.toThrow('Unauthorized: Websocket session id does not match auth ticket');
    });
});
