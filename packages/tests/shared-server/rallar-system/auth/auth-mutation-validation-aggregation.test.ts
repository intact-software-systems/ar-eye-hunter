import { describe, expect, it } from 'vitest';

import type {
    AuthMutationCommand,
    AuthMutationRead
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import type { PersistedAuthUser } from '@shared-server/rallar-system/auth/persistence/persisted-auth-user.ts';

const command: Extract<AuthMutationCommand, { kind: 'register-user'; }> = {
    version: 1,
    kind: 'register-user',
    requestId: 'register-request',
    capturedAtEpochMs: -1,
    user: {
        clientId: 'client-1',
        username: 'alice',
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
    }
};

describe('auth mutation validation aggregation', () => {
    it('returns every independent issue in deterministic order without throwing', () => {
        const read: Extract<AuthMutationRead, { kind: 'register-user'; }> = {
            kind: 'register-user',
            byUsername: entry({ ...command.user, clientId: 'other-client' }, 'username=alice'),
            byClientId: entry({ ...command.user, username: 'other-user' }, 'client=client-1')
        };
        const facts = { kind: command.kind, serviceId: 'auth-service' } as const;
        const computed = computeAuthMutation({ command, read, facts });

        expect(() => validateAuthMutation({ command, read, facts, computed })).not.toThrow();
        expect(validateAuthMutation({ command, read, facts, computed })).toEqual([
            expect.objectContaining({
                path: 'command.capturedAtEpochMs',
                message: 'Auth command timestamp is invalid'
            }),
            expect.objectContaining({
                path: 'read.byUsername',
                message: 'Auth username already exists'
            }),
            expect.objectContaining({
                path: 'read.byClientId',
                message: 'Auth client identity already exists'
            })
        ]);
    });
});

function entry(value: PersistedAuthUser, key: string) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 0
        },
        value
    };
}
