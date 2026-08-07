import { describe, expect, it, vi } from 'vitest';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { AuthSessionRepository, decodePersistedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { createAuthMutationService, type IssueAuthSessionCommand } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

import { createResilience, TestResourceInbox, TestResourceInboxResults, waitForQueuedEntry } from './app-auth-inbox-test-harness.ts';
const AUTH_INBOX_TYPES = [
    'AUTH_USER_REGISTER',
    'AUTH_SESSION_ISSUE',
    'AUTH_SESSION_LOGOUT',
    'AUTH_WS_TICKET_ISSUE',
    'AUTH_WS_TICKET_CONSUME',
    'AUTH_AGENT_SESSION_TICKETS_ISSUE',
    'AUTH_AGENT_SESSION_TICKET_CONSUME',
] as const;

describe('AppAuthInboxService architecture', () => {
    it('registers all seven callbacks in order before any later queue invocation', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const reader = new InboxQueueReader(queue);
        const registrations = vi.spyOn(reader, 'onInboxMessageDo');
        const runtime = new FakeRuntimeStateRepository();
        const mutationService = createAuthMutationService({
            runtimeRepository: runtime,
            serviceId: 'auth-registration-service',
        });
        const read = vi.spyOn(mutationService, 'read');
        const service = new AppAuthInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
            mutationService,
            createHmacAuthCredentialIssuer('auth-registration-secret-0123456789abcdef'),
            'auth-registration-service',
        );

        expect(registrations.mock.calls.map(([type]) => type)).toEqual(
            AUTH_INBOX_TYPES.map((type) => AppInboxType[type]),
        );
        expect(read).not.toHaveBeenCalled();

        const pending = service.logoutSession({
            requestId: 'registration-later-invocation',
            capturedAtEpochMs: 1_000,
            session: {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'session-1',
                accessToken: 'absent-access-token',
                issuedAtEpochMs: 500,
                expiresAtEpochMs: 2_000,
            },
        });
        await waitForQueuedEntry(queue);
        expect(read).not.toHaveBeenCalled();

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        await expect(pending).resolves.toMatchObject({ right: { loggedOut: true } });
        expect(read).toHaveBeenCalledOnce();
    });

    it('defines every mandatory auth mutation command at the AppInbox boundary', () => {
        expect(AUTH_INBOX_TYPES.map((type) => AppInboxType[type])).toEqual(
            AUTH_INBOX_TYPES,
        );
    });

    it('strictly decodes token-free persisted auth sessions', () => {
        const persisted = {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest: 'digest-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000,
        };
        expect(decodePersistedAuthSession(persisted)).toEqual(persisted);
        for (
            const invalid of [
                { ...persisted, accessToken: 'plaintext-token' },
                { ...persisted, credentialSeed: 'reconstructable' },
                { ...persisted, accessTokenDigest: 12 },
                { ...persisted, expiresAtEpochMs: Number.POSITIVE_INFINITY },
                Object.fromEntries(
                    Object.entries(persisted).filter(([key]) => key !== 'accessTokenDigest'),
                ),
            ]
        ) {
            expect(() => decodePersistedAuthSession(invalid)).toThrow(TypeError);
        }
    });

    it('rejects malformed legacy plaintext session rows instead of widening them', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new AuthSessionRepository(runtime);
        const expiresAtEpochMs = Date.now() + 60_000;
        const accessToken = 'legacy-malformed-token';
        const malformed = JSON.stringify({
            clientId: 'legacy-client',
            username: 'legacy-user',
            sessionId: 'legacy-malformed-session',
            accessToken,
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs,
            credentialSeed: 'unexpected-reconstruction-material',
        });
        await runtime.upsert(
            'auth-sessions:by-session',
            'session=legacy-malformed-session',
            malformed,
            expiresAtEpochMs,
        );
        await runtime.upsert(
            'auth-sessions:by-token',
            `token=${encodeURIComponent(accessToken)}`,
            malformed,
            expiresAtEpochMs,
        );

        await expect(repository.findBySessionId('legacy-malformed-session'))
            .rejects.toThrow(TypeError);
        await expect(repository.findByAccessToken(accessToken))
            .rejects.toThrow(TypeError);
        await expect(repository.findLegacySessionByAccessTokenDigestEntry(
            await hashAuthSecret(accessToken),
        )).rejects.toThrow(TypeError);
    });

    it('does not persist session or success results for malformed lifecycle commands', async () => {
        const capturedAtEpochMs = Date.now() + 60_000;
        const invalidLifecycles = [
            {
                label: 'backdated',
                issuedAtEpochMs: capturedAtEpochMs - 1,
                expiresAtEpochMs: capturedAtEpochMs + 60_000,
            },
            {
                label: 'future-issued',
                issuedAtEpochMs: capturedAtEpochMs + 1,
                expiresAtEpochMs: capturedAtEpochMs + 60_000,
            },
            {
                label: 'equal-expiry',
                issuedAtEpochMs: capturedAtEpochMs,
                expiresAtEpochMs: capturedAtEpochMs,
            },
            {
                label: 'reversed-expiry',
                issuedAtEpochMs: capturedAtEpochMs,
                expiresAtEpochMs: capturedAtEpochMs - 1,
            },
        ] as const;
        for (const lifecycle of invalidLifecycles) {
            const queue = new TestResourceInbox();
            const results = new TestResourceInboxResults();
            const reader = new InboxQueueReader(queue);
            const runtime = new FakeRuntimeStateRepository();
            const credentialIssuer = createHmacAuthCredentialIssuer(
                'invalid-lifecycle-secret-0123456789abcdef',
            );
            const service = new AppAuthInboxService(
                reader,
                queue as never,
                results as never,
                createAppInboxTestDatabase(queue, results, {
                    runtimeRepository: runtime,
                }),
                createAuthMutationService({
                    runtimeRepository: runtime,
                    serviceId: 'auth-test-service',
                }),
                credentialIssuer,
                'auth-test-service',
            );
            const command = {
                version: 1,
                kind: 'issue-session',
                requestId: `invalid-lifecycle-${lifecycle.label}`,
                capturedAtEpochMs,
                authority: {
                    kind: 'static-client',
                    clientId: 'client-1',
                    normalizedUsername: 'alice',
                },
                session: {
                    clientId: 'client-1',
                    username: 'alice',
                    sessionId: `invalid-session-${lifecycle.label}`,
                    accessTokenDigest: await hashAuthSecret(
                        await credentialIssuer.issueAccessToken(
                            `invalid-session-${lifecycle.label}`,
                        ),
                    ),
                    issuedAtEpochMs: lifecycle.issuedAtEpochMs,
                    expiresAtEpochMs: lifecycle.expiresAtEpochMs,
                },
            } as IssueAuthSessionCommand;
            const pending = service.processAuthCommandUntilCompletion(command);
            const firstOutcome = await Promise.race([
                pending.then(
                    (value) => ({ kind: 'settled' as const, value }),
                    (error: unknown) => ({ kind: 'rejected' as const, error }),
                ),
                waitForQueuedEntry(queue).then(() => ({ kind: 'queued' as const })),
            ]);
            let rejected = firstOutcome.kind === 'rejected';
            if (firstOutcome.kind === 'queued') {
                await reader.dequeueInbox(
                    InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    createResilience(),
                );
                try {
                    const result = await pending;
                    rejected = result.right === undefined;
                } catch {
                    rejected = true;
                }
            }

            expect(rejected).toBe(true);
            expect(
                [...runtime.data.keys()].filter((key) =>
                    key.startsWith('auth-sessions:by-token::') ||
                    key.startsWith('auth-sessions:by-session::')
                ),
            ).toEqual([]);
            expect(
                results.allEntries().some((entry) =>
                    entry.status === EntityStatus.COMPLETED ||
                    entry.resource.includes('session-issued')
                ),
            ).toBe(false);
        }
    });

});
