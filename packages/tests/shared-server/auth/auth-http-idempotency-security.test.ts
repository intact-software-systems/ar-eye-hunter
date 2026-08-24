import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
    createAuthInboxTestResilience,
    createAuthInboxTestRuntime,
    readEntries,
    runAuthCommand,
    waitForAuthInboxEntry,
    type AuthInboxTestRuntime
} from './auth-app-inbox-test-runtime.ts';

const SHARED_REQUEST_ID = 'SharedLogoutRequest_0123456789abcdefghijklmnopqrstuv';

describe('auth HTTP AppInbox idempotency security', () => {
    it('uses operation topics and collision-safe scoped contexts', async () => {
        const runtime = createRuntime();
        const session = await putSession(runtime, 'client:a', 'session:a');

        await runAuthCommand({
            pending: runtime.auth.service.logoutSession({
                requestId: SHARED_REQUEST_ID,
                session
            }),
            queue: runtime.auth.queue,
            reader: runtime.auth.reader
        });

        const [entry] = await readEntries(runtime.auth.queue);
        expect(entry.key).toEqual(toAppQueueKey({
            topicId: AppInboxType.AUTH_SESSION_LOGOUT,
            resourceId: SHARED_REQUEST_ID,
            contextId: 'client=client%3Aa:session=session%3Aa'
        }));
    });

    it('replays each invalidated caller and denies cross-proof disclosure', async () => {
        const runtime = createRuntime();
        const first = await putSession(runtime, 'client-first', 'session-first');
        const second = await putSession(runtime, 'client-second', 'session-second');

        await logout(runtime.auth, first, 1);
        await logout(runtime.auth, second, 2);

        await expect(runtime.auth.service.replayLogoutSessionWithCredentialProof({
            requestId: SHARED_REQUEST_ID,
            clientId: first.clientId,
            accessToken: first.accessToken
        })).resolves.toMatchObject({ right: { loggedOut: true } });
        await expect(runtime.auth.service.replayLogoutSessionWithCredentialProof({
            requestId: SHARED_REQUEST_ID,
            clientId: second.clientId,
            accessToken: second.accessToken
        })).resolves.toMatchObject({ right: { loggedOut: true } });
        await expect(runtime.auth.service.replayLogoutSessionWithCredentialProof({
            requestId: SHARED_REQUEST_ID,
            clientId: second.clientId,
            accessToken: first.accessToken
        })).resolves.toBeNull();
    });

    it('converges equal login intent on one winner', async () => {
        const runtime = createRuntime();
        const first = runtime.auth.service.issueSession({
            requestId: 'ConcurrentLoginRequest_0123',
            clientId: 'static-client',
            username: 'Alice',
            authority: {
                kind: 'static-client',
                clientId: 'static-client',
                normalizedUsername: 'alice'
            },
            ttlMs: 60_000
        });
        const second = runtime.auth.service.issueSession({
            requestId: 'ConcurrentLoginRequest_0123',
            clientId: 'static-client',
            username: 'Alice',
            authority: {
                kind: 'static-client',
                clientId: 'static-client',
                normalizedUsername: 'alice'
            },
            ttlMs: 60_000
        });

        await waitForAuthInboxEntry(runtime.auth.queue);
        await runtime.auth.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createAuthInboxTestResilience()
        );
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(secondResult.left).toBeUndefined();
        expect(firstResult.right).toEqual(secondResult.right);
        expect(await readEntries(runtime.auth.queue)).toHaveLength(1);
        expect(runtime.auth.results.allEntries()).toHaveLength(1);
    });

    it('samples login time and creates credential facts only for the atomic winner', async () => {
        const issuer = createHmacAuthCredentialIssuer(
            'auth-winner-fact-secret-0123456789abcdef'
        );
        const issuedAccessTokenSessionIds: string[] = [];
        const credentialIssuer = {
            ...issuer,
            issueAccessToken: async (sessionId: string) => {
                issuedAccessTokenSessionIds.push(sessionId);
                return await issuer.issueAccessToken(sessionId);
            }
        };
        const sampledTimes: number[] = [];
        const nowEpochMs = () => {
            sampledTimes.push(5_000);
            return 5_000;
        };
        const runtimeRepository = new FakeRuntimeStateRepository();
        const auth = createAuthInboxTestRuntime({
            runtimeRepository,
            serviceId: 'auth-winner-fact-service',
            credentialSecret: 'unused-auth-winner-fact-secret-0123456789abcdef',
            credentialIssuer,
            nowEpochMs
        });
        const input = {
            requestId: 'WinnerOwnedLoginRequest_01',
            clientId: 'static-client',
            username: 'Alice',
            authority: {
                kind: 'static-client' as const,
                clientId: 'static-client',
                normalizedUsername: 'alice'
            },
            ttlMs: 60_000
        };

        const first = auth.service.issueSession(input);
        const second = auth.service.issueSession(input);
        await waitForAuthInboxEntry(auth.queue);

        expect(sampledTimes).toEqual([]);
        expect(issuedAccessTokenSessionIds).toEqual([]);

        await auth.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createAuthInboxTestResilience()
        );
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(sampledTimes).toEqual([5_000]);
        expect(issuedAccessTokenSessionIds).toHaveLength(3);
        expect(firstResult.right).toEqual(secondResult.right);

        const replay = await auth.service.issueSession(input);

        expect(replay.right).toEqual(firstResult.right);
        expect(sampledTimes).toEqual([5_000]);
        expect(issuedAccessTokenSessionIds).toHaveLength(4);
    });

    it('starts login TTL after winner execution rather than reservation queue delay', async () => {
        let currentTime = 0;
        const sampledTimes: number[] = [];
        const nowEpochMs = () => {
            sampledTimes.push(currentTime);
            return currentTime;
        };
        const runtimeRepository = new FakeRuntimeStateRepository();
        const auth = createAuthInboxTestRuntime({
            runtimeRepository,
            serviceId: 'auth-winner-ttl-service',
            credentialSecret: 'auth-winner-ttl-secret-0123456789abcdef',
            nowEpochMs
        });
        const pending = auth.service.issueSession({
            requestId: 'WinnerTtlLoginRequest_0123',
            clientId: 'static-client',
            username: 'Alice',
            authority: {
                kind: 'static-client',
                clientId: 'static-client',
                normalizedUsername: 'alice'
            },
            ttlMs: 60_000
        });
        await waitForAuthInboxEntry(auth.queue);
        const [queued] = await readEntries(auth.queue);
        expect(sampledTimes).toEqual([]);
        expect(queued.resource).not.toContain('capturedAtEpochMs');
        expect(queued.resource).not.toContain('sessionId');
        expect(queued.resource).not.toContain('accessTokenDigest');

        currentTime = 9_000;
        await auth.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createAuthInboxTestResilience()
        );
        const result = await pending;

        expect(result.right?.expiresAtEpochMs).toBe(69_000);
        expect(sampledTimes).toEqual([9_000]);
    });

    it('timestamps registration at worker execution without persisting the password', async () => {
        let currentTime = 0;
        const sampledTimes: number[] = [];
        const nowEpochMs = () => {
            sampledTimes.push(currentTime);
            return currentTime;
        };
        const runtimeRepository = new FakeRuntimeStateRepository();
        const auth = createAuthInboxTestRuntime({
            runtimeRepository,
            serviceId: 'auth-winner-registration-service',
            credentialSecret: 'auth-winner-registration-secret-0123456789abcdef',
            nowEpochMs
        });
        const input = {
            requestId: 'WinnerRegistrationRequest_01',
            request: {
                username: 'DelayedAlice',
                password: 'registration-password-must-not-persist'
            }
        };
        const pending = auth.service.registerUser(input);
        await waitForAuthInboxEntry(auth.queue);
        const [queued] = await readEntries(auth.queue);

        expect(sampledTimes).toEqual([]);
        expect(queued.resource).not.toContain(input.request.password);
        expect(queued.resource).not.toContain('capturedAtEpochMs');
        expect(queued.resource).not.toContain('createdAtEpochMs');
        expect(queued.resource).not.toContain('clientId');

        currentTime = 9_000;
        await auth.reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createAuthInboxTestResilience()
        );
        const result = await pending;

        expect(result.right?.registeredAtEpochMs).toBe(9_000);
        expect(sampledTimes).toEqual([9_000]);

        const replay = await auth.service.registerUser(input);

        expect(replay.right).toEqual(result.right);
        expect(sampledTimes).toEqual([9_000]);
    });

    it('replays a consumed agent ticket only with its original credential proof', async () => {
        const runtime = createRuntime();
        const authority = await putSession(runtime, 'operator-client', 'operator-session');
        const issued = await runAuthCommand({
            pending: runtime.auth.service.issueAgentSessionTickets({
                requestId: 'AgentTicketIssueRequest_0123',
                session: authority,
                ticketTtlMs: 30_000,
                agents: [{ agentId: 'agent-one' }]
            }),
            queue: runtime.auth.queue,
            reader: runtime.auth.reader
        });
        const ticket = issued.right?.tickets[0]?.ticket;
        if (!ticket) {
            throw new Error('Expected an issued agent session ticket');
        }
        const consumeInput = {
            requestId: 'AgentTicketConsumeRequest_0123456789abcdefghijklmnop',
            ticket
        };
        const consumed = await runAuthCommand({
            pending: runtime.auth.service.consumeAgentSessionTicket(consumeInput),
            queue: runtime.auth.queue,
            reader: runtime.auth.reader,
            minimumEntries: 2
        });

        const replayed = await runtime.auth.service.consumeAgentSessionTicket(consumeInput);

        expect(replayed.right).toEqual(consumed.right);
        expect(await readEntries(runtime.auth.queue)).toHaveLength(2);
    });
});

function createRuntime(): Readonly<{
    auth: AuthInboxTestRuntime;
    repository: AuthSessionRepository;
}> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    return {
        auth: createAuthInboxTestRuntime({
            runtimeRepository,
            serviceId: 'auth-http-idempotency-service',
            credentialSecret: 'auth-http-idempotency-secret-0123456789abcdef'
        }),
        repository: new AuthSessionRepository(runtimeRepository)
    };
}

async function putSession(
    runtime: ReturnType<typeof createRuntime>,
    clientId: string,
    sessionId: string
) {
    const issuedAtEpochMs = Date.now();
    const session = {
        clientId,
        username: clientId,
        sessionId,
        accessToken: await runtime.auth.credentialIssuer.issueAccessToken(sessionId),
        issuedAtEpochMs,
        expiresAtEpochMs: issuedAtEpochMs + 60_000
    };
    await runtime.repository.putSession(session);
    return session;
}

async function logout(
    auth: AuthInboxTestRuntime,
    session: Awaited<ReturnType<typeof putSession>>,
    minimumEntries: number
): Promise<void> {
    const result = await runAuthCommand({
        pending: auth.service.logoutSession({
            requestId: SHARED_REQUEST_ID,
            session
        }),
        queue: auth.queue,
        reader: auth.reader,
        minimumEntries
    });
    expect(result.right).toEqual({ loggedOut: true });
}
