import { describe, expect, it } from 'vitest';

import type { AuthMutationRead, IssueAuthSessionCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';

const command: IssueAuthSessionCommand = {
    version: 1,
    kind: 'issue-session',
    requestId: 'session-write',
    capturedAtEpochMs: 1_000,
    authority: { kind: 'static-client', clientId: 'client', normalizedUsername: 'alice' },
    session: {
        clientId: 'client',
        username: 'alice',
        sessionId: 'session:value',
        accessTokenDigest: 'token:value',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 61_000
    }
};
const read: AuthMutationRead = {
    kind: 'issue-session',
    userByUsername: null,
    userByClientId: null,
    byToken: null,
    bySession: null,
    expiredByTokenEntry: null,
    expiredBySessionEntry: null
};

describe('auth session persistence computation', () => {
    it('computes both index keys, original JSON bytes and ISO expiry before write', () => {
        const computed = computeAuthMutation({ command, read, facts: { kind: command.kind }, serviceId: 'auth' });

        expect(computed.sessions[0]).toMatchObject({
            tokenStorageKey: 'token-digest=token%3Avalue',
            sessionStorageKey: 'session=session%3Avalue',
            serializedValue:
                '{"clientId":"client","username":"alice","sessionId":"session:value","accessTokenDigest":"token:value","issuedAtEpochMs":1000,"expiresAtEpochMs":61000}',
            expireAtIsoTimestamp: '1970-01-01T00:01:01.000Z',
            expectedTokenRevision: null,
            expectedSessionRevision: null
        });
        expect(() => validateAuthMutation(command, read, computed)).not.toThrow();
    });

    it.each(['tokenStorageKey', 'sessionStorageKey', 'serializedValue', 'expireAtIsoTimestamp', 'expectedTokenRevision', 'expectedSessionRevision'] as const)(
        'rejects a changed %s without replacing the candidate',
        (field) => {
            const computed = computeAuthMutation({ command, read, facts: { kind: command.kind }, serviceId: 'auth' });
            const changed = { ...computed.sessions[0], [field]: 'forged' };
            const candidate = { ...computed, sessions: [changed] };

            expect(() => Reflect.apply(validateAuthMutation, undefined, [command, read, candidate])).toThrow(AuthMutationRejectedError);
            expect(candidate.sessions[0][field]).toBe('forged');
        }
    );

    it('rejects a session persistence accessor before invoking it', () => {
        const computed = computeAuthMutation({ command, read, facts: { kind: command.kind }, serviceId: 'auth' });
        let calls = 0;
        const changed = Object.defineProperty({ ...computed.sessions[0] }, 'serializedValue', {
            get: () => {
                calls += 1;
                throw new Error('Accessor must not execute');
            }
        });

        expect(() => validateAuthMutation(command, read, { ...computed, sessions: [changed] })).toThrow(AuthMutationRejectedError);
        expect(calls).toBe(0);
    });
});
