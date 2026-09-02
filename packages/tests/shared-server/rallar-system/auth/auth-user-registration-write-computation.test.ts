import { describe, expect, it } from 'vitest';

import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation, type ComputeAuthMutationInput } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';
import { writeAuthMutation } from '@shared-server/rallar-system/auth/mutation/write/write-auth-mutation.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAuthInboxTestRuntime } from './auth-app-inbox-test-runtime.ts';

const user = {
    clientId: 'client:value',
    username: 'Alice',
    normalizedUsername: 'alice',
    displayName: 'Alice',
    passwordHash: 'password-hash',
    passwordSalt: 'password-salt',
    passwordAlgorithm: 'pbkdf2-sha256',
    passwordIterations: 120_000,
    roles: ['member'],
    status: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000
} as const;

describe('auth user registration write computation', () => {
    it('computes exact user-index writes and persists without inspecting the command user inside write', async () => {
        const input = createRegistrationInput();
        const computed = computeAuthMutation(input);
        expect(computed).toMatchObject({
            userRegistration: {
                usernameStorageKey: 'username=alice',
                clientIdStorageKey: 'client=client%3Avalue',
                serializedValue: JSON.stringify(user),
                expireAtIsoTimestamp: '9999-12-31T23:59:59.999Z'
            }
        });
        validateAuthMutation(input.command, input.read, computed);
        const runtime = new FakeRuntimeStateRepository();
        const harness = createAuthInboxTestRuntime({
            runtimeRepository: runtime,
            serviceId: 'auth-user-registration',
            credentialSecret: 'test-secret-0123456789abcdef0123456789abcdef'
        });
        let userReadsDuringWrite = 0;
        Object.defineProperty(input.command, 'user', {
            get: () => {
                userReadsDuringWrite += 1;
                throw new Error('Command user inspected inside write');
            }
        });

        const result = await harness.database.begin((transaction) => writeAuthMutation(transaction, computed));

        expect(userReadsDuringWrite).toBe(0);
        expect(result).toEqual({
            requestId: 'register-user',
            clientId: user.clientId,
            username: user.username,
            displayName: user.displayName,
            registeredAtEpochMs: user.createdAtEpochMs
        });
        for (
            const [namespace, key] of [
                ['auth-users:by-username', 'username=alice'],
                ['auth-users:by-client-id', 'client=client%3Avalue']
            ] as const
        ) {
            expect(await runtime.findEntry(namespace, key)).toMatchObject({
                value: JSON.stringify(user),
                expireAtTimestamp: 253_402_300_799_999,
                revision: 0
            });
        }
    });

    it.each([
        { usernameStorageKey: 'username=forged' },
        { clientIdStorageKey: 'client=forged' },
        { serializedValue: '{}' },
        { expireAtIsoTimestamp: '2000-01-01T00:00:00.000Z' }
    ])('rejects altered computed user persistence: %o', (change) => {
        const input = createRegistrationInput();
        const computed = computeAuthMutation(input);
        const candidate = {
            ...computed,
            userRegistration: { ...computed.userRegistration!, ...change }
        };

        expect(() => Reflect.apply(validateAuthMutation, undefined, [input.command, input.read, candidate])).toThrow(AuthMutationRejectedError);
        expect(candidate.userRegistration).toMatchObject(change);
    });
});

function createRegistrationInput(): ComputeAuthMutationInput {
    return {
        command: {
            version: 1,
            kind: 'register-user',
            requestId: 'register-user',
            capturedAtEpochMs: 1_000,
            user
        },
        read: { kind: 'register-user', byUsername: null, byClientId: null },
        facts: { kind: 'register-user' },
        serviceId: 'auth'
    };
}
