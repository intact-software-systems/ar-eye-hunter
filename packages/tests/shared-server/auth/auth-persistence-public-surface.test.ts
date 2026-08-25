import { describe, expect, it } from 'vitest';

import { decodePersistedAuthSession, decodePersistedAuthUser, decodePersistedWebSocketTicket } from '@shared-server/mod.ts';

describe('auth persistence public surface', () => {
    it('decodes current stored auth values through the package entry', () => {
        expect(decodePersistedAuthSession({
            clientId: 'client-1',
            username: 'Alice',
            sessionId: 'session-1',
            accessTokenDigest: 'access-token-digest',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        })).toMatchObject({ sessionId: 'session-1' });
        expect(decodePersistedWebSocketTicket({
            ticketDigest: 'ticket-digest',
            accessTokenDigest: 'access-token-digest',
            sessionId: 'session-1',
            clientId: 'client-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        })).toMatchObject({ ticketDigest: 'ticket-digest' });
        expect(decodePersistedAuthUser({
            clientId: 'client-1',
            username: 'Alice',
            normalizedUsername: 'alice',
            displayName: null,
            passwordHash: 'password-hash',
            passwordSalt: 'password-salt',
            passwordAlgorithm: 'pbkdf2-sha256',
            passwordIterations: 120_000,
            roles: ['member'],
            status: 'active',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000
        })).toMatchObject({ normalizedUsername: 'alice' });
    });
});
