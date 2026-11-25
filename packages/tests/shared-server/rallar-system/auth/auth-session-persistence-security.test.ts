import { describe, expect, it } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

const corruptCanonicalSessionCase = 'catches a corrupted canonical session returned as a miss instead of failing closed';

describe('auth session persistence security', () => {
    it('catches canonical session persistence that stores a plaintext access token', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtimeRepository);
        const accessToken = 'plaintext-access-token';

        await repository.putSession({
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessToken,
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: Date.now() + 60_000
        });

        const persistedJson = [...runtimeRepository.data.values()]
            .map((entry) => entry.value)
            .join('\n');
        expect(persistedJson).not.toContain(accessToken);
        expect(persistedJson).toContain('accessTokenDigest');
        expect([...runtimeRepository.data.values()].map((entry) => entry.key).sort()).toEqual([
            'session=session-1',
            expect.stringMatching(/^token-digest=/u)
        ]);
    });

    it(corruptCanonicalSessionCase, async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await runtimeRepository.upsert(
            {
                namespace: 'auth-sessions:by-session',
                key: 'session=session-1',
                value: JSON.stringify({
                    clientId: 'client-1',
                    username: 'alice',
                    sessionId: 'different-session',
                    accessTokenDigest: 'digest-1',
                    issuedAtEpochMs: 1_000,
                    expiresAtEpochMs: Date.now() + 60_000
                }),
                expireAtTimestamp: Date.now() + 60_000
            }
        );

        await expect(
            new AuthSessionRepository(runtimeRepository).findBySessionId('session-1')
        ).rejects.toThrow('Persisted auth session id identity differs');
    });
});

it('rejects guest transport rows in the account token index on write and on read', async () => {
    const { hashAuthSecret } = await import('@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts');
    const { AUTH_SESSIONS_BY_TOKEN_NAMESPACE, authTokenDigestKey } = await import('@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts');
    const runtime = new FakeRuntimeStateRepository();
    const repository = new AuthSessionRepository(runtime);
    const accessTokenDigest = await hashAuthSecret('test-guest-token');
    const row = { clientId: 'guest-' + 'a'.repeat(64), sessionId: 'guest-session-' + 'b'.repeat(64), username: 'guest', guestRoom: {
        applicationId: 'app', workspaceId: 'ws', groupId: 'town'
    }, accessTokenDigest, issuedAtEpochMs: 1000, expiresAtEpochMs: Date.now() + 60000 };
    await expect(repository.insertSessionByTokenDigest(row)).rejects.toThrow(/guest transport/i);
    await runtime.upsert({ namespace: AUTH_SESSIONS_BY_TOKEN_NAMESPACE, key: authTokenDigestKey(accessTokenDigest),
        value: JSON.stringify(row), expireAtTimestamp: row.expiresAtEpochMs });
    await expect(repository.findByAccessToken('test-guest-token')).rejects.toThrow(/guest transport/i);
});
