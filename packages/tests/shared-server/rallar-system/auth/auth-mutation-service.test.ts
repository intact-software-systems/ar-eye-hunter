import { describe, expect, it } from 'vitest';

import { createAuthMutationService, type AuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('auth mutation service phases', () => {
    it('preserves the direct read, compute, validate, and no-op write phase returns', async () => {
        const service: AuthMutationService = createAuthMutationService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            serviceId: 'auth-service'
        });
        const command = {
            version: 1,
            kind: 'logout-session',
            requestId: 'logout-request',
            capturedAtEpochMs: 1_000,
            expected: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessTokenDigest: 'access-token-digest',
                issuedAtEpochMs: 500,
                expiresAtEpochMs: 2_000
            }
        } as const;

        const read = await service.read(command);
        const computed = service.compute(command, read, { kind: command.kind });

        expect(read).toEqual({
            kind: 'logout-session',
            byToken: null,
            bySession: null,
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        });
        expect(computed.command).toBe(command);
        expect(computed.read).toBe(read);
        expect(computed.outcome).toBe('no-op');
        expect(service.validate(command, read, computed)).toBeUndefined();
        await expect(service.write(undefined as never, computed)).resolves.toBe(computed.result);
    });
});
