import { describe, expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';

import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';

import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
    createAuthInboxTestRuntime,
    createResilience,
    TestResourceInbox,
    TestResourceInboxResults,
    waitForQueuedEntry,
    type AuthInboxTestRuntime
} from './auth-app-inbox-test-runtime.ts';
const AUTH_INBOX_TYPES = [
    'AUTH_USER_REGISTER',
    'AUTH_SESSION_ISSUE',
    'AUTH_SESSION_LOGOUT',
    'AUTH_WS_TICKET_ISSUE',
    'AUTH_WS_TICKET_CONSUME',
    'AUTH_AGENT_SESSION_TICKETS_ISSUE',
    'AUTH_AGENT_SESSION_TICKET_CONSUME'
] as const;

describe('AppAuthInboxService registration', () => {
    it('registers all seven callbacks in order before any later queue invocation', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const registrations = vi.spyOn(reader, 'onInboxMessageDo');
        const runtime = new FakeRuntimeStateRepository();
        const mutationService = createAuthMutationService({
            runtimeRepository: runtime,
            serviceId: 'auth-registration-service'
        });
        const read = vi.spyOn(mutationService, 'read');
        const service = new AppAuthInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
                authMutationService: mutationService,
                credentialIssuer: createHmacAuthCredentialIssuer(
                    'auth-registration-secret-0123456789abcdef'
                )
            },
            {
                serviceId: 'auth-registration-service'
            }
        );

        expect(registrations.mock.calls.map(([type]) => type)).toEqual(
            AUTH_INBOX_TYPES.map((type) => AppInboxType[type])
        );
        expect(read).not.toHaveBeenCalled();

        const pending = service.logoutSession({
            requestId: 'registration-later-invocation',
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessToken: 'absent-access-token',
                issuedAtEpochMs: 500,
                expiresAtEpochMs: 2_000
            }
        });
        await waitForQueuedEntry(queue);
        expect(read).not.toHaveBeenCalled();

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        await expect(pending).resolves.toMatchObject({ right: { loggedOut: true } });
        expect(read).toHaveBeenCalledOnce();
    });
});

it('defines every mandatory auth mutation command at the AppInbox boundary', () => {
    expect(AUTH_INBOX_TYPES.map((type) => AppInboxType[type])).toEqual(AUTH_INBOX_TYPES);
});

it('does not persist session or success results for invalid session TTL intent', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const auth = createAuthInboxTestRuntime({
        runtimeRepository,
        serviceId: 'auth-test-service',
        credentialSecret: 'invalid-lifecycle-secret-0123456789abcdef'
    });
    const result = await auth.service.issueSession({
        requestId: 'invalid-session-ttl',
        clientId: 'client-1',
        username: 'alice',
        authority: {
            kind: 'static-client',
            clientId: 'client-1',
            normalizedUsername: 'alice'
        },
        ttlMs: 0
    });

    expect(result.right).toBeUndefined();
    expect(result.left?.status).toBe(400);
    expectSessionStorageEmpty(runtimeRepository);
    expect(
        auth.results
            .allEntries()
            .some(
                (entry) => entry.status === EntityStatus.COMPLETED || entry.resource.includes('session-issued')
            )
    ).toBe(false);
});

function expectSessionStorageEmpty(runtimeRepository: FakeRuntimeStateRepository): void {
    expect(
        [...runtimeRepository.data.keys()].filter(
            (key) => key.startsWith('auth-sessions:by-token::') || key.startsWith('auth-sessions:by-session::')
        )
    ).toEqual([]);
}
