import { describe, expect, it } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { decodePersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

describe('auth persisted session codecs', () => {
    it('strictly decodes token-free persisted auth sessions', () => {
        const persisted = {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest: 'digest-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        };
        expect(decodePersistedAuthSession(persisted)).toEqual(persisted);
        for (
            const invalid of [
                { ...persisted, accessToken: 'plaintext-token' },
                { ...persisted, credentialSeed: 'reconstructable' },
                { ...persisted, accessTokenDigest: 12 },
                { ...persisted, expiresAtEpochMs: Number.POSITIVE_INFINITY },
                Object.fromEntries(Object.entries(persisted).filter(([key]) => key !== 'accessTokenDigest'))
            ]
        ) {
            expect(() => decodePersistedAuthSession(invalid)).toThrow(TypeError);
        }
    });

    it('rejects malformed current session rows and ignores plaintext token keys', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtime);
        const expiresAtEpochMs = Date.now() + 60_000;
        const accessToken = 'predecessor-malformed-token';
        const malformed = JSON.stringify({
            clientId: 'predecessor-client',
            username: 'predecessor-user',
            sessionId: 'predecessor-malformed-session',
            accessToken,
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
            credentialSeed: 'unexpected-reconstruction-material'
        });
        await runtime.upsert(
            'auth-sessions:by-session',
            'session=predecessor-malformed-session',
            malformed,
            expiresAtEpochMs
        );
        await runtime.upsert(
            'auth-sessions:by-token',
            `token=${encodeURIComponent(accessToken)}`,
            malformed,
            expiresAtEpochMs
        );

        await expect(repository.findBySessionId('predecessor-malformed-session')).rejects.toThrow(
            TypeError
        );
        await expect(repository.findByAccessToken(accessToken)).resolves.toBeUndefined();
    });
});
