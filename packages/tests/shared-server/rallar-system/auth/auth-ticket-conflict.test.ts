import { expect, it } from 'vitest';

import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { ConsumeAuthWsTicketCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { captureAuthMutationFacts } from '@shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAuthInboxTestRuntime, runAuthInboxCommand, type AuthInboxTestRuntime } from './auth-app-inbox-test-runtime.ts';

interface ConsumeRaceTicketTwiceInput {
    readonly auth: AuthInboxTestRuntime;
    readonly sessionId: string;
    readonly ticket: string;
}

it('rejects a corrupted websocket ticket before deleting it', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const sessions = new AuthSessionRepository(runtime);
    const credentialIssuer = createHmacAuthCredentialIssuer(
        'ws-corruption-secret-0123456789abcdef-extra'
    );
    const now = Date.now();
    const session = {
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessToken: await credentialIssuer.issueAccessToken('session-1'),
        issuedAtEpochMs: now - 1,
        expiresAtEpochMs: now + 60_000
    };
    await sessions.putSession(session);
    const ticket = await credentialIssuer.issueWebSocketTicket(
        'ws-corrupt-consume',
        session.sessionId
    );
    const ticketDigest = await hashAuthSecret(ticket);
    await sessions.insertWebSocketTicket({
        ticketDigest,
        accessTokenDigest: await hashAuthSecret('wrong-access-token'),
        sessionId: session.sessionId,
        clientId: session.clientId,
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + 30_000
    });
    const command: ConsumeAuthWsTicketCommand = {
        version: 1,
        kind: 'consume-ws-ticket',
        requestId: 'ws-corrupt-consume',
        capturedAtEpochMs: now + 1,
        ticketDigest,
        expectedSessionId: session.sessionId
    };
    const service = createAuthMutationService({
        runtimeRepository: runtime,
        serviceId: 'auth-test-service'
    });
    const read = await service.read(command);
    const computed = service.compute(
        command,
        read,
        await captureAuthMutationFacts(command, credentialIssuer)
    );

    expect(() => service.validate(command, read, computed)).toThrow(/authority|token/u);
    expect(await sessions.findWebSocketTicketByDigestEntry(ticketDigest)).toBeDefined();
});

it(
    'selects one CAS winner for concurrent username creation and ticket consumption',
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
    const now = Date.now();
    const clientId = await expectSingleRegistrationWinner(auth);
    const session = await issueRaceSession(auth, now, clientId);
    const ticket = await issueRaceTicket(auth, session);
    const consumeResults = await consumeRaceTicketTwice({
        auth,
        sessionId: session.sessionId,
        ticket
    });

    expect(consumeResults.filter((result) => result.right !== undefined)).toHaveLength(1);
    expect(consumeResults.filter((result) => result.left?.status === 404)).toHaveLength(1);
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
            request
        }),
        auth.service.registerUser({
            requestId: 'register-race-b',
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

async function issueRaceSession(
    auth: AuthInboxTestRuntime,
    now: number,
    clientId: string
): Promise<IssuedAuthSession> {
    const issuedAtEpochMs = now + 1;
    const login = await runAuthInboxCommand({
        pending: auth.service.issueSession({
            requestId: 'ticket-race-session',
            clientId,
            username: 'same-user',
            authority: {
                kind: 'registered-user',
                clientId,
                normalizedUsername: 'same-user',
                userRevision: 0
            },
            ttlMs: 60_000
        }),
        queue: auth.queue,
        reader: auth.reader,
        minimumEntries: 3
    });
    return { ...login.right!, issuedAtEpochMs };
}

async function issueRaceTicket(
    auth: AuthInboxTestRuntime,
    session: IssuedAuthSession
): Promise<string> {
    const issuedTicket = await runAuthInboxCommand({
        pending: auth.service.issueWebSocketTicket({
            requestId: 'ticket-race-issue',
            session,
            ttlMs: 30_000
        }),
        queue: auth.queue,
        reader: auth.reader,
        minimumEntries: 4
    });
    return issuedTicket.right!.ticket;
}

async function consumeRaceTicketTwice({
    auth,
    sessionId,
    ticket
}: ConsumeRaceTicketTwiceInput) {
    const consumes = [
        auth.service.consumeWebSocketTicket({
            requestId: 'ticket-race-consume-a',
            expectedSessionId: sessionId,
            ticket
        }),
        auth.service.consumeWebSocketTicket({
            requestId: 'ticket-race-consume-b',
            expectedSessionId: sessionId,
            ticket
        })
    ];
    await auth.queue.waitForEntryCount(6);
    await dequeue(auth);
    await dequeue(auth);
    return await Promise.all(consumes);
}

async function dequeue(auth: AuthInboxTestRuntime): Promise<void> {
    await auth.reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAppInboxTestResilience()
    );
}
