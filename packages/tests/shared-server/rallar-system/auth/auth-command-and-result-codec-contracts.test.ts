import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AuthMutationCommand, AuthMutationResult } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { decodeAuthMutationCommand } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts';
import { decodeAuthMutationResult } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts';

type AuthMutationResultVariant = AuthMutationResult extends
    & Readonly<{ requestId: string; }>
    & infer Variant ? Variant :
    never;

type AuthMutationResultDiscriminant<T = AuthMutationResultVariant> = T extends Readonly<{ registeredAtEpochMs: number; }> ? 'registeredAtEpochMs' :
    T extends Readonly<{ loggedOut: boolean; }> ? 'loggedOut' :
    T extends Readonly<{ kind: infer Kind; }> ? Kind :
    never;

type ExpectedAuthMutationDiscriminant =
    | 'register-user'
    | 'issue-session'
    | 'logout-session'
    | 'issue-ws-ticket'
    | 'consume-ws-ticket'
    | 'issue-agent-tickets'
    | 'consume-agent-ticket';

type ExpectedAuthMutationResultDiscriminant =
    | 'registeredAtEpochMs'
    | 'loggedOut'
    | 'session-issued'
    | 'ws-ticket-issued'
    | 'ws-ticket-consumed'
    | 'agent-tickets-issued'
    | 'agent-ticket-consumed';

const user = {
    clientId: 'client-1',
    username: 'alice',
    normalizedUsername: 'alice',
    displayName: null,
    passwordHash: 'password-hash',
    passwordSalt: 'password-salt',
    passwordAlgorithm: 'pbkdf2-sha256',
    passwordIterations: 120_000,
    roles: ['member'],
    status: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000
} as const;

const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessTokenDigest: 'access-token-digest',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000
} as const;

const commandFixtures = [
    {
        version: 1,
        kind: 'register-user',
        requestId: 'register-request',
        capturedAtEpochMs: 1_000,
        user
    },
    {
        version: 1,
        kind: 'issue-session',
        requestId: 'session-request',
        capturedAtEpochMs: 1_000,
        authority: {
            kind: 'registered-user',
            clientId: 'client-1',
            normalizedUsername: 'alice',
            userRevision: 3
        },
        session
    },
    {
        version: 1,
        kind: 'logout-session',
        requestId: 'logout-request',
        capturedAtEpochMs: 1_001,
        expected: session
    },
    {
        version: 1,
        kind: 'issue-ws-ticket',
        requestId: 'ws-issue-request',
        capturedAtEpochMs: 1_001,
        ticketRecord: {
            ticketDigest: 'ws-ticket-digest',
            accessTokenDigest: session.accessTokenDigest,
            sessionId: session.sessionId,
            clientId: session.clientId,
            issuedAtEpochMs: 1_001,
            expiresAtEpochMs: 1_500
        }
    },
    {
        version: 1,
        kind: 'consume-ws-ticket',
        requestId: 'ws-consume-request',
        capturedAtEpochMs: 1_002,
        ticketDigest: 'ws-ticket-digest',
        expectedSessionId: session.sessionId
    },
    {
        version: 1,
        kind: 'issue-agent-tickets',
        requestId: 'agent-issue-request',
        capturedAtEpochMs: 1_001,
        authority: session,
        tickets: [
            {
                agentId: 'agent-1',
                sessionId: 'agent-session-1',
                accessTokenDigest: 'agent-access-token-digest',
                ticketDigest: 'agent-ticket-digest',
                clientId: session.clientId,
                username: session.username,
                issuedAtEpochMs: 1_001,
                sessionExpiresAtEpochMs: 2_000,
                ticketExpiresAtEpochMs: 1_500
            }
        ]
    },
    {
        version: 1,
        kind: 'consume-agent-ticket',
        requestId: 'agent-consume-request',
        capturedAtEpochMs: 1_002,
        ticketDigest: 'agent-ticket-digest'
    }
] as const;

const resultFixtures = [
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
        ...session
    },
    {
        requestId: 'ws-issue-request',
        kind: 'ws-ticket-issued',
        ticketDigest: 'ws-ticket-digest',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_001,
        expiresAtEpochMs: 1_500
    },
    {
        requestId: 'ws-consume-request',
        kind: 'ws-ticket-consumed',
        ...session
    },
    {
        requestId: 'agent-issue-request',
        kind: 'agent-tickets-issued',
        tickets: [
            {
                agentId: 'agent-1',
                ticketDigest: 'agent-ticket-digest',
                sessionId: 'agent-session-1',
                issuedAtEpochMs: 1_001,
                expiresAtEpochMs: 1_500
            }
        ]
    },
    {
        requestId: 'agent-consume-request',
        kind: 'agent-ticket-consumed',
        ...session
    }
] as const;

const [
    registerCommand,
    issueSessionCommand,
    logoutCommand,
    issueWebSocketTicketCommand,
    consumeWebSocketTicketCommand,
    issueAgentTicketsCommand,
    consumeAgentTicketCommand
] = commandFixtures;

const [
    registrationResult,
    logoutResult,
    sessionIssuedResult,
    webSocketTicketIssuedResult,
    webSocketTicketConsumedResult,
    agentTicketsIssuedResult,
    agentTicketConsumedResult
] = resultFixtures;

it('catches a contract that drops or adds a command or durable-result discriminant', () => {
    expectTypeOf<AuthMutationCommand['kind']>().toEqualTypeOf<ExpectedAuthMutationDiscriminant>();
    const resultType = expectTypeOf<AuthMutationResultDiscriminant>();
    resultType.toEqualTypeOf<ExpectedAuthMutationResultDiscriminant>();
});

it('catches a decoder that drops any of the seven command discriminants', () => {
    for (const command of commandFixtures) {
        const decoded = decodeAuthMutationCommand(command);

        expect(decoded).toEqual(command);
        expect(decoded).not.toBe(command);
    }
});

it('catches a command decoder that accepts extra or plaintext credential fields', () => {
    for (const command of commandFixtures) {
        expect(() => decodeAuthMutationCommand({ ...command, unexpected: true })).toThrow(TypeError);
        expect(() => decodeAuthMutationCommand({ ...command, accessToken: 'plaintext' })).toThrow(
            TypeError
        );
    }
});

it('catches a command decoder that weakens any nested exact-field contract', () => {
    const invalidNestedCommands = [
        {
            ...registerCommand,
            user: { ...registerCommand.user, unexpected: true }
        },
        {
            ...issueSessionCommand,
            authority: { ...issueSessionCommand.authority, unexpected: true }
        },
        {
            ...issueSessionCommand,
            session: { ...issueSessionCommand.session, unexpected: true }
        },
        {
            ...logoutCommand,
            expected: { ...logoutCommand.expected, unexpected: true }
        },
        {
            ...issueWebSocketTicketCommand,
            ticketRecord: { ...issueWebSocketTicketCommand.ticketRecord, unexpected: true }
        },
        {
            ...issueAgentTicketsCommand,
            authority: { ...issueAgentTicketsCommand.authority, unexpected: true }
        },
        {
            ...issueAgentTicketsCommand,
            tickets: [{ ...issueAgentTicketsCommand.tickets[0], unexpected: true }]
        }
    ];

    for (const command of invalidNestedCommands) {
        expect(() => decodeAuthMutationCommand(command)).toThrow(TypeError);
    }
});

it('catches invalid nested timestamps and lifecycles in every command family', () => {
    const invalidCommandLifecycles = [
        {
            ...registerCommand,
            user: { ...registerCommand.user, createdAtEpochMs: -1 }
        },
        {
            ...issueSessionCommand,
            session: { ...issueSessionCommand.session, issuedAtEpochMs: 999 }
        },
        {
            ...logoutCommand,
            expected: { ...logoutCommand.expected, expiresAtEpochMs: 1_000 }
        },
        {
            ...issueWebSocketTicketCommand,
            ticketRecord: {
                ...issueWebSocketTicketCommand.ticketRecord,
                expiresAtEpochMs: 1_001
            }
        },
        { ...consumeWebSocketTicketCommand, capturedAtEpochMs: -1 },
        {
            ...issueAgentTicketsCommand,
            authority: {
                ...issueAgentTicketsCommand.authority,
                expiresAtEpochMs: issueAgentTicketsCommand.authority.issuedAtEpochMs
            }
        },
        {
            ...issueAgentTicketsCommand,
            tickets: [
                {
                    ...issueAgentTicketsCommand.tickets[0],
                    sessionExpiresAtEpochMs: 1_001
                }
            ]
        },
        { ...consumeAgentTicketCommand, capturedAtEpochMs: Number.NaN }
    ];

    for (const command of invalidCommandLifecycles) {
        expect(() => decodeAuthMutationCommand(command)).toThrow(TypeError);
    }
});

it('catches a result decoder that weakens exact fields, cloning, or credential secrecy', () => {
    for (const result of resultFixtures) {
        const decoded = decodeAuthMutationResult(result);

        expect(decoded).toEqual(result);
        expect(decoded).not.toBe(result);
        expect(() => decodeAuthMutationResult({ ...result, unexpected: true })).toThrow(TypeError);
        expect(() => decodeAuthMutationResult({ ...result, ticket: 'plaintext' })).toThrow(TypeError);
    }
});

it('catches invalid fields, timestamps, or lifecycles in every result family', () => {
    const invalidResults = [
        { ...registrationResult, registeredAtEpochMs: -1 },
        { ...logoutResult, loggedOut: false },
        { ...sessionIssuedResult, expiresAtEpochMs: sessionIssuedResult.issuedAtEpochMs },
        {
            ...webSocketTicketIssuedResult,
            expiresAtEpochMs: webSocketTicketIssuedResult.issuedAtEpochMs
        },
        { ...webSocketTicketConsumedResult, issuedAtEpochMs: Number.NaN },
        {
            ...agentTicketsIssuedResult,
            tickets: [{ ...agentTicketsIssuedResult.tickets[0], unexpected: true }]
        },
        {
            ...agentTicketsIssuedResult,
            tickets: [
                {
                    ...agentTicketsIssuedResult.tickets[0],
                    expiresAtEpochMs: agentTicketsIssuedResult.tickets[0].issuedAtEpochMs
                }
            ]
        },
        {
            ...agentTicketConsumedResult,
            expiresAtEpochMs: agentTicketConsumedResult.issuedAtEpochMs
        }
    ];

    for (const result of invalidResults) {
        expect(() => decodeAuthMutationResult(result)).toThrow(TypeError);
    }
});
