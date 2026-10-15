import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAuthInboxTestRuntime } from './auth-app-inbox-test-runtime.ts';

interface GatedDerivation {
    readonly id: number;
    readonly release: () => void;
}

describe('auth password derivation admission', () => {
    afterEach(() => vi.restoreAllMocks());

    it('runs at most the bound at once and admits derivations in arrival order', async () => {
        const admission = new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 2 });
        const started: GatedDerivation[] = [];
        const completed: number[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const derivations = Array.from({ length: 8 }, (_, id) =>
            admission.admit(() => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                return new Promise<number>((resolve) => {
                    started.push({
                        id,
                        release: () => {
                            inFlight -= 1;
                            resolve(id);
                        }
                    });
                });
            }).then((id) => {
                completed.push(id);
                return id;
            }));

        await Promise.resolve();
        expect(started.map((derivation) => derivation.id)).toEqual([0, 1]);

        for (let released = 0; released < 8; released += 1) {
            started[released]!.release();
            await vi.waitFor(() => expect(started.length).toBe(Math.min(8, released + 3)));
        }
        await Promise.all(derivations);

        expect(maxInFlight).toBe(2);
        expect(started.map((derivation) => derivation.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(completed).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('rejects a bound below one at construction', () => {
        expect(() => new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 0 })).toThrow(TypeError);
    });

    it('admits registration derivations through the service-owned bound', async () => {
        const auth = createAuthInboxTestRuntime({
            runtimeRepository: new FakeRuntimeStateRepository(),
            serviceId: 'bounded-derivation-auth',
            credentialSecret: 'bounded-derivation-secret-0123456789abcdef',
            passwordDerivationAdmission: new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 1 })
        });
        const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
        let inFlight = 0;
        let maxInFlight = 0;
        vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(async (...args) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                return await deriveBits(...args);
            }
            finally {
                inFlight -= 1;
            }
        });

        const registrations = [1, 2, 3].map((index) =>
            auth.service.registerUser({
                requestId: `BoundedRegistrationRequest_0${index}`,
                request: { username: `bounded-user-${index}`, password: `bounded-password-${index}` }
            })
        );
        await auth.queue.waitForEntryCount(3);
        for (let dequeue = 0; dequeue < 3; dequeue += 1) {
            await auth.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience());
        }
        const registered = await Promise.all(registrations);

        expect(maxInFlight).toBe(1);
        expect(registered.map((registration) => registration.right?.username)).toEqual([
            'bounded-user-1',
            'bounded-user-2',
            'bounded-user-3'
        ]);
    });
});
