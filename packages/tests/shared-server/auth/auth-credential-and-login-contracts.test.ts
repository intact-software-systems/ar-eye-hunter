import { describe, expect, it } from 'vitest';

import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { authenticateAuthUser, type AuthUserLoginRepository } from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import type { PersistedAuthUser } from '@shared-server/rallar-system/auth/persistence/persisted-auth-user.ts';
import type { RuntimeStateEntryValue } from '@shared-server/runtime-state/runtime-state-json-store.ts';

const credentialSecret = 'auth-task-one-secret-0123456789abcdef';
const credentialDomainCase = 'catches a credential issuer that changes the locked HMAC domain, purpose, or identity';
const registrationShapeCase = 'catches registration that changes password metadata or emits an incomplete user';
const wrongPasswordOrderCase = 'rejects a wrong password before reading session authority revision';
const disabledLoginOrderCase = 'rejects a disabled user before reading credentials or revision';

describe('auth credential issuer', () => {
    it(credentialDomainCase, async () => {
        const issuer = createHmacAuthCredentialIssuer(credentialSecret);

        await expect(issuer.issueAccessToken('session-1')).resolves.toBe(
            'd7o5FFiHIJx_t-Q5D8bifed9yKjbZ0iIlahYJHof--g'
        );
        await expect(issuer.issueWebSocketTicket('request-1', 'session-1')).resolves.toBe(
            'qhOBnvdnS9XjjUffy--_rQ2DJKSZY8qbXUCz5J6lGVE'
        );
        await expect(issuer.issueAgentTicket('request-1', 'agent-1', 'session-1')).resolves.toBe(
            '3m0dlqbcWOvUtYop1Ca97r2Ts4LiYiMuxgV9cskZByM'
        );
    });
});

describe('auth registration', () => {
    it(registrationShapeCase, async () => {
        const registered = await prepareAuthUserRegistration(
            { username: '  Alice  ', password: 'secret', displayName: ' Alice Example ' },
            { clientId: 'client-1', capturedAtEpochMs: 1_000 }
        );

        expect(registered).toMatchObject({
            clientId: 'client-1',
            username: 'Alice',
            normalizedUsername: 'alice',
            displayName: 'Alice Example',
            passwordAlgorithm: 'pbkdf2-sha256',
            passwordIterations: 120_000,
            roles: ['member'],
            status: 'active',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 1_000
        });
        expect(registered.passwordHash).not.toContain('secret');
        expect(registered.passwordSalt).not.toBe('');
    });
});

describe('auth registered login', () => {
    it('catches login that bypasses registered password proof or exposes credentials', async () => {
        const registered = await prepareAuthUserRegistration(
            { username: 'Alice', password: 'secret' },
            { clientId: 'client-1', capturedAtEpochMs: 1_000 }
        );
        const userRepository: AuthUserLoginRepository = {
            findByNormalizedUsernameEntry: async () => storedAuthUser(registered)
        };

        await expect(
            authenticateAuthUser({ username: 'ALICE', password: 'secret' }, { userRepository })
        ).resolves.toEqual({
            clientId: 'client-1',
            username: 'Alice',
            authority: {
                kind: 'registered-user',
                clientId: 'client-1',
                normalizedUsername: 'alice',
                userRevision: 7
            }
        });
        await expect(
            authenticateAuthUser({ username: 'alice', password: 'wrong' }, { userRepository })
        ).resolves.toBeUndefined();
    });
});

describe('auth login accessor evaluation order', () => {
    it(wrongPasswordOrderCase, async () => {
        const registered = await prepareAuthUserRegistration(
            { username: 'active-user', password: 'secret' },
            { clientId: 'client-1', capturedAtEpochMs: 1_000 }
        );
        const reads: string[] = [];
        const stored = storedAuthUser(registered);
        const userRepository: AuthUserLoginRepository = {
            findByNormalizedUsernameEntry: async () => ({
                get value() {
                    reads.push('value');
                    return registered;
                },
                get entry() {
                    reads.push('revision');
                    return stored.entry;
                }
            })
        };

        await expect(
            authenticateAuthUser({ username: 'active-user', password: 'wrong' }, { userRepository })
        ).resolves.toBeUndefined();
        expect(reads).toEqual(['value', 'value']);
    });

    it(disabledLoginOrderCase, async () => {
        const registered = await prepareAuthUserRegistration(
            { username: 'disabled-user', password: 'secret' },
            { clientId: 'client-1', capturedAtEpochMs: 1_000 }
        );
        const reads: string[] = [];
        const disabled: PersistedAuthUser = {
            ...registered,
            get status(): 'disabled' {
                reads.push('status');
                return 'disabled';
            }
        };
        const stored = storedAuthUser(disabled);
        reads.length = 0;
        const userRepository: AuthUserLoginRepository = {
            findByNormalizedUsernameEntry: async () => ({
                get value() {
                    reads.push('value');
                    return disabled;
                },
                get entry() {
                    reads.push('revision');
                    return stored.entry;
                }
            })
        };
        const loginRequest = {
            username: 'disabled-user',
            get password() {
                reads.push('password');
                return 'secret';
            }
        };

        await expect(authenticateAuthUser(loginRequest, { userRepository })).resolves.toBeUndefined();
        expect(reads).toEqual(['value', 'status']);
    });
});

function storedAuthUser(value: PersistedAuthUser): RuntimeStateEntryValue<PersistedAuthUser> {
    return {
        entry: {
            key: `username=${encodeURIComponent(value.normalizedUsername)}`,
            value: JSON.stringify(value),
            expireAtTimestamp: 253_402_300_799_999,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 7
        },
        value
    };
}
