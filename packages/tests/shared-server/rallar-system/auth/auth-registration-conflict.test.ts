import { expect, it } from 'vitest';

import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAuthInboxTestRuntime, type AuthInboxTestRuntime } from './auth-app-inbox-test-runtime.ts';

it(
    'selects one CAS winner for concurrent username creation',
    selectsSingleConcurrentWinner,
    15_000
);

async function selectsSingleConcurrentWinner(): Promise<void> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const auth = createAuthInboxTestRuntime({
        runtimeRepository,
        serviceId: 'auth-test-service',
        credentialSecret: 'concurrent-auth-secret-0123456789abcdef'
    });
    await expectSingleRegistrationWinner(auth);
}

async function expectSingleRegistrationWinner(
    auth: AuthInboxTestRuntime
): Promise<string> {
    const request = {
        username: 'same-user',
        password: 'password-1'
    };
    const registrations = [
        auth.service.registerUser({
            requestId: 'register-race-a',
            traceId: 'trace-auth-test',
            request
        }),
        auth.service.registerUser({
            requestId: 'register-race-b',
            traceId: 'trace-auth-test',
            request
        })
    ];
    await auth.queue.waitForEntryCount(2);
    await dequeue(auth);
    await dequeue(auth);
    const registrationResults = await Promise.all(registrations);
    expect(registrationResults.filter((result) => result.right !== undefined)).toHaveLength(1);
    expect(registrationResults.filter((result) => result.left?.status === 409)).toHaveLength(1);
    const winner = registrationResults.find((result) => result.right !== undefined)?.right;
    if (winner === undefined) {
        throw new Error('Expected one successful auth registration');
    }
    return winner.clientId;
}

async function dequeue(auth: AuthInboxTestRuntime): Promise<void> {
    await auth.reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAppInboxTestResilience()
    );
}
