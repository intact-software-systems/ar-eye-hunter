import { describe, expect, it } from 'vitest';

import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { decodeAuthMutationCommand } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts';
import { decodeAuthMutationResult } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts';

const validDurableResults = [
    {
        requestId: 'register-request',
        clientId: 'client-1',
        username: 'alice',
        displayName: null,
        registeredAtEpochMs: 1_000
    },
    { requestId: 'logout-request', loggedOut: true },
    {
        requestId: 'session-request',
        kind: 'session-issued',
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest: 'digest-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000
    },
    {
        requestId: 'ws-issue-request',
        kind: 'ws-ticket-issued',
        ticketDigest: 'ticket-digest',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000
    },
    {
        requestId: 'ws-consume-request',
        kind: 'ws-ticket-consumed',
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest: 'digest-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000
    },
    {
        requestId: 'agent-consume-request',
        kind: 'agent-ticket-consumed',
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest: 'digest-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000
    },
    {
        requestId: 'agent-issue-request',
        kind: 'agent-tickets-issued',
        tickets: [
            {
                agentId: 'agent-1',
                ticketDigest: 'ticket-digest',
                sessionId: 'agent-session-1',
                issuedAtEpochMs: 1_000,
                expiresAtEpochMs: 2_000
            }
        ]
    }
];

it('preserves the exact auth mutation rejection error contract', () => {
    expect(new AuthMutationRejectedError('rejected')).toMatchObject({
        name: 'AuthMutationRejectedError',
        message: 'rejected',
        code: 'auth-mutation-rejected',
        status: 409
    });
    expect(new AuthMutationRejectedError('unauthorized', 401)).toMatchObject({
        name: 'AuthMutationRejectedError',
        message: 'unauthorized',
        code: 'auth-mutation-rejected',
        status: 401
    });
});

it('strictly decodes every durable auth result variant', () => {
    for (const result of validDurableResults) {
        expect(decodeAuthMutationResult(result)).toEqual(result);
    }
});

it('strictly rejects every malformed durable auth result variant', () => {
    for (
        const invalid of [
            Object.fromEntries(
                Object.entries(validDurableResults[0]).filter(([key]) => key !== 'requestId')
            ),
            { loggedOut: true },
            { ...validDurableResults[2], accessToken: 'plaintext-token' },
            { ...validDurableResults[2], unexpected: true },
            {
                kind: 'agent-tickets-issued',
                tickets: [{ ...validDurableResults[6].tickets![0], ticket: 'x' }]
            },
            { kind: 'agent-tickets-issued', tickets: [null] },
            { ...validDurableResults[3], expiresAtEpochMs: Number.NaN },
            Object.create({ kind: 'session-issued' })
        ]
    ) {
        expect(() => decodeAuthMutationResult(invalid)).toThrow(TypeError);
    }
});

it('requires current agent session and ticket lifecycles to outlive issuance', () => {
    const ticket = {
        agentId: 'agent-1',
        sessionId: 'agent-session-1',
        accessTokenDigest: 'agent-access-token-digest',
        ticketDigest: 'agent-ticket-digest',
        clientId: 'client-1',
        username: 'alice',
        issuedAtEpochMs: 1_000,
        sessionExpiresAtEpochMs: 2_000,
        ticketExpiresAtEpochMs: 1_500
    };
    const command = {
        version: 1,
        kind: 'issue-agent-tickets',
        requestId: 'agent-ticket-command',
        capturedAtEpochMs: 1_000,
        authority: {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'session-1',
            accessTokenDigest: 'authority-access-token-digest',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 3_000
        },
        tickets: [ticket]
    };

    expect(decodeAuthMutationCommand(command)).toEqual(command);
    for (
        const invalidTicket of [
            { ...ticket, sessionExpiresAtEpochMs: ticket.issuedAtEpochMs },
            { ...ticket, ticketExpiresAtEpochMs: ticket.issuedAtEpochMs }
        ]
    ) {
        expect(() => decodeAuthMutationCommand({ ...command, tickets: [invalidTicket] })).toThrow(
            /lifecycle/u
        );
    }
});

it('requires an exact registered-user authority on session issuance commands', () => {
    const command = {
        version: 1,
        kind: 'issue-session',
        requestId: 'session-authority-command',
        capturedAtEpochMs: 1_000,
        authority: {
            kind: 'registered-user',
            clientId: 'client-1',
            normalizedUsername: 'alice',
            userRevision: 3
        },
        session: {
            clientId: 'client-1',
            username: 'Alice',
            sessionId: 'session-1',
            accessTokenDigest: 'digest-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        }
    } as const;

    expect(decodeAuthMutationCommand(command)).toEqual(command);
    expect(() =>
        decodeAuthMutationCommand({
            ...command,
            authority: {
                kind: 'registered-user',
                clientId: 'client-1',
                normalizedUsername: 'alice'
            }
        })
    ).toThrow(TypeError);
});

it('binds session issuance lifecycle to the durable command timestamp', () => {
    const base = {
        version: 1,
        kind: 'issue-session',
        requestId: 'invalid-session-lifecycle',
        capturedAtEpochMs: 1_000,
        authority: {
            kind: 'static-client',
            clientId: 'client-1',
            normalizedUsername: 'alice'
        },
        session: {
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'invalid-session',
            accessTokenDigest: 'digest-1',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        }
    } as const;

    for (
        const session of [
            { ...base.session, issuedAtEpochMs: 999 },
            { ...base.session, issuedAtEpochMs: 1_001 },
            { ...base.session, expiresAtEpochMs: 1_000 },
            { ...base.session, expiresAtEpochMs: 999 }
        ]
    ) {
        expect(() =>
            decodeAuthMutationCommand({
                ...base,
                session
            })
        ).toThrow(/lifecycle/u);
    }
});

it('strictly rejects plaintext or extra auth command fields', () => {
    expect(() =>
        decodeAuthMutationCommand({
            version: 1,
            kind: 'consume-agent-ticket',
            requestId: 'consume-1',
            capturedAtEpochMs: 1_000,
            ticketDigest: 'digest',
            ticket: 'plaintext'
        })
    ).toThrow(/fields|plaintext/u);
});
