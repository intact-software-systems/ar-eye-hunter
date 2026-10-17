import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAuthInboxTestHarness, runAuthInboxCommand } from './auth-app-inbox-test-runtime.ts';

describe('auth registration password derivation count', () => {
    afterEach(() => vi.restoreAllMocks());

    it('derives the password once for a fresh registration and matches replays by derivation', async () => {
        const auth = createAuthInboxTestHarness(new FakeRuntimeStateRepository());
        const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
        let derivations = 0;
        vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(async (...args) => {
            derivations += 1;
            return await deriveBits(...args);
        });
        const input = {
            requestId: 'RegistrationDerivationRequest_01',
            request: {
                username: 'derivation-user',
                password: 'derivation-password'
            }
        };

        const registered = await runAuthInboxCommand({
            pending: auth.service.registerUser(input),
            queue: auth.queue,
            reader: auth.reader
        });

        expect(registered.right).toMatchObject({ username: 'derivation-user' });
        expect(derivations).toBe(1);

        const samePasswordReplay = await auth.service.registerUser(input);

        expect(samePasswordReplay.right).toEqual(registered.right);
        expect(derivations).toBe(2);

        const differentPasswordReplay = await auth.service.registerUser({
            ...input,
            request: { ...input.request, password: 'another-password' }
        });

        expect(differentPasswordReplay.right).toBeUndefined();
        expect(differentPasswordReplay.left).toMatchObject({ status: 409 });
        expect(derivations).toBe(3);
    });
});
