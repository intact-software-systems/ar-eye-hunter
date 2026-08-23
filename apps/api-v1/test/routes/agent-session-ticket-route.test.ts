import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { AgentSessionTicketResponse, ConsumeAgentSessionTicketResponse } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import * as configRoutes from '../../src/routes/config-route.ts';
import { authenticationRequired } from '../../src/services/request-auth-service.ts';

const NOW_EPOCH_MS = Date.now();
const ISSUE_REQUEST_ID = 'AgentIssueRequest_01234567';
const CONSUME_REQUEST_ID = 'AgentConsumeRequest_012345';

Deno.test('agent session ticket route rejects unauthenticated issue requests', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.reject(authenticationRequired('Bearer credential was not provided'))
    });

    const response = await app.request(
        `/api/auth/agent-session-tickets/requests/${ISSUE_REQUEST_ID}`,
        {
            method: 'POST',
            body: JSON.stringify({ agentIds: ['controller-01'] })
        }
    );

    assert.equal(response.status, 401);
    assert.deepEqual(
        await response.json(),
        mutationFailure(
            'authentication-required',
            401,
            'Bearer credential was not provided'
        )
    );
});

Deno.test('agent session ticket route mints distinct same-user sessions and consumes a ticket once', async () => {
    const sessions = new Map<string, ConsumeAgentSessionTicketResponse>();
    const consumedByRequest = new Map<string, ConsumeAgentSessionTicketResponse>();
    const app = createApp({
        requireApiAuthSession: () => Promise.resolve(createAuthSession()),
        appAuthInbox: ({
            issueAgentSessionTickets: (input: {
                agents: readonly { agentId: string; sessionId?: string; }[];
                ticketTtlMs: number;
            }) =>
                Promise.resolve(Either.ofRight({
                    tickets: input.agents.map(({ agentId, sessionId: candidateSessionId }) => {
                        const sessionId = candidateSessionId ?? `${agentId}-session`;
                        const ticket = `ticket-for-${sessionId}-long-enough`;
                        sessions.set(ticket, {
                            clientId: 'alice-client',
                            username: 'alice',
                            accessToken: `access-for-${sessionId}-long-enough`,
                            sessionId,
                            expiresAtEpochMs: NOW_EPOCH_MS + 86_400_000
                        });
                        return {
                            agentId,
                            ticket,
                            sessionId,
                            expiresAtEpochMs: NOW_EPOCH_MS + input.ticketTtlMs
                        };
                    })
                })),
            consumeAgentSessionTicket: (input: { requestId: string; ticket: string; }) => {
                const replay = consumedByRequest.get(input.requestId);
                if (replay) {
                    return Promise.resolve(Either.ofRight(replay));
                }
                const session = sessions.get(input.ticket);
                if (!session) {
                    return Promise.resolve(Either.ofLeft({
                        type: 'app-inbox-failure',
                        version: 'canonical.v2',
                        code: 'agent-session-ticket-invalid',
                        message: 'Agent session ticket is invalid or expired.',
                        status: 404,
                        issues: null,
                        denial: null,
                        retry: null
                    }));
                }
                sessions.delete(input.ticket);
                consumedByRequest.set(input.requestId, session);
                return Promise.resolve(Either.ofRight(session));
            }
        }) as never,
        now: () => NOW_EPOCH_MS
    });

    const issueResponse = await app.request(
        `/api/auth/agent-session-tickets/requests/${ISSUE_REQUEST_ID}`,
        {
            method: 'POST',
            headers: {
                authorization: 'Bearer operator-token',
                'x-client-id': 'alice-client'
            },
            body: JSON.stringify({ agentIds: ['controller-01', 'controller-02'] })
        }
    );
    const issued = await issueResponse.json() as AgentSessionTicketResponse;

    assert.equal(issueResponse.status, 200);
    assert.equal(issued.tickets.length, 2);
    assert.deepEqual(issued.tickets.map((ticket) => ticket.agentId), [
        'controller-01',
        'controller-02'
    ]);
    assert.notEqual(issued.tickets[0].sessionId, 'operator-session');
    assert.notEqual(issued.tickets[0].sessionId, issued.tickets[1].sessionId);
    assert.ok(issued.tickets[0].ticket.length > 20);

    const consumeResponse = await app.request(
        `/api/auth/agent-session-tickets/consume/requests/${CONSUME_REQUEST_ID}`,
        {
            method: 'POST',
            body: JSON.stringify({ ticket: issued.tickets[0].ticket })
        }
    );
    const consumed = await consumeResponse.json() as ConsumeAgentSessionTicketResponse;

    assert.equal(consumeResponse.status, 200);
    assert.equal(consumed.clientId, 'alice-client');
    assert.equal(consumed.username, 'alice');
    assert.equal(consumed.sessionId, issued.tickets[0].sessionId);
    assert.ok(consumed.accessToken.length > 20);
    assert.equal(issued.tickets[0].expiresAtEpochMs, NOW_EPOCH_MS + 60_000);
    assert.equal(consumed.expiresAtEpochMs, NOW_EPOCH_MS + 86_400_000);

    const repeatConsumeResponse = await app.request(
        `/api/auth/agent-session-tickets/consume/requests/${CONSUME_REQUEST_ID}`,
        {
            method: 'POST',
            body: JSON.stringify({ ticket: issued.tickets[0].ticket })
        }
    );

    assert.equal(repeatConsumeResponse.status, 200);
    assert.deepEqual(await repeatConsumeResponse.json(), consumed);

    const differentRequestResponse = await app.request(
        '/api/auth/agent-session-tickets/consume/requests/AgentConsumeDifferent_0123',
        {
            method: 'POST',
            body: JSON.stringify({ ticket: issued.tickets[0].ticket })
        }
    );
    assert.equal(differentRequestResponse.status, 404);
    assert.deepEqual(
        await differentRequestResponse.json(),
        mutationFailure(
            'agent-session-ticket-invalid',
            404,
            'Agent session ticket is invalid or expired.'
        )
    );
});

function createApp(
    dependencies: Partial<configRoutes.ConfigRouteDependencies>
): Hono {
    const app = new Hono();
    configRoutes.registerConfigRoutes(app, {
        requireApiAuthSession: () => Promise.resolve(createAuthSession()),
        readEnv: () => undefined,
        now: () => NOW_EPOCH_MS,
        createTokenId: () => crypto.randomUUID(),
        appAuthInbox: {} as never,
        authUserRepository: {} as never,
        staticClients: [],
        registrationMode: 'public',
        adminClientIds: new Set(),
        ...dependencies
    });
    return app;
}

function mutationFailure(code: string, status: number, message: string) {
    return {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code,
        status,
        message,
        issues: null,
        denial: status === 401 ? { code, message, details: null } : null,
        retry: null
    };
}

function createAuthSession(): IssuedAuthSession {
    return {
        clientId: 'alice-client',
        username: 'alice',
        accessToken: 'operator-token',
        sessionId: 'operator-session',
        issuedAtEpochMs: NOW_EPOCH_MS,
        expiresAtEpochMs: NOW_EPOCH_MS + 86_400_000
    };
}
