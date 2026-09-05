import { describe, expect, it } from 'vitest';

import type { AuthMutationCommand, AuthMutationRead, AuthMutationResult } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';

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
const websocketTicket = {
    ticketDigest: 'websocket-ticket-digest',
    accessTokenDigest: session.accessTokenDigest,
    sessionId: session.sessionId,
    clientId: session.clientId,
    issuedAtEpochMs: 1_001,
    expiresAtEpochMs: 1_500
} as const;
const agentTicketCommand = {
    agentId: 'agent-1',
    sessionId: 'agent-session-1',
    accessTokenDigest: 'agent-access-token-digest',
    ticketDigest: 'agent-ticket-digest',
    clientId: session.clientId,
    username: session.username,
    issuedAtEpochMs: 1_001,
    sessionExpiresAtEpochMs: 2_000,
    ticketExpiresAtEpochMs: 1_500
} as const;
const agentTicket = {
    ticketDigest: agentTicketCommand.ticketDigest,
    accessTokenDigest: agentTicketCommand.accessTokenDigest,
    sessionId: agentTicketCommand.sessionId,
    clientId: agentTicketCommand.clientId,
    agentId: agentTicketCommand.agentId,
    issuedAtEpochMs: agentTicketCommand.issuedAtEpochMs,
    expiresAtEpochMs: agentTicketCommand.ticketExpiresAtEpochMs
} as const;
const emptySessionEntries = {
    byToken: null,
    bySession: null,
    expiredByTokenEntry: null,
    expiredBySessionEntry: null
} as const;

const operationMatrix: readonly Readonly<{
    command: AuthMutationCommand;
    read: AuthMutationRead;
    result: AuthMutationResult;
}>[] = [
    {
        command: {
            version: 1,
            kind: 'register-user',
            requestId: 'register-request',
            capturedAtEpochMs: 1_000,
            user
        },
        read: { kind: 'register-user', byUsername: null, byClientId: null },
        result: {
            requestId: 'register-request',
            clientId: 'client-1',
            username: 'alice',
            displayName: null,
            registeredAtEpochMs: 1_000
        }
    },
    {
        command: {
            version: 1,
            kind: 'issue-session',
            requestId: 'session-request',
            capturedAtEpochMs: 1_000,
            authority: { kind: 'static-client', clientId: 'client-1', normalizedUsername: 'alice' },
            session
        },
        read: {
            kind: 'issue-session',
            userByUsername: null,
            userByClientId: null,
            ...emptySessionEntries
        },
        result: { requestId: 'session-request', kind: 'session-issued', ...session }
    },
    {
        command: {
            version: 1,
            kind: 'logout-session',
            requestId: 'logout-request',
            capturedAtEpochMs: 1_001,
            expected: session
        },
        read: {
            kind: 'logout-session',
            byToken: entry(session, 'token-digest=access-token-digest'),
            bySession: entry(session, 'session=session-1'),
            expiredByTokenEntry: null,
            expiredBySessionEntry: null
        },
        result: { requestId: 'logout-request', loggedOut: true }
    },
    {
        command: {
            version: 1,
            kind: 'issue-ws-ticket',
            requestId: 'websocket-issue-request',
            capturedAtEpochMs: 1_001,
            ticketRecord: websocketTicket
        },
        read: {
            kind: 'issue-ws-ticket',
            ticket: null,
            expiredTicketEntry: null,
            session: entry(session, 'session=session-1')
        },
        result: {
            requestId: 'websocket-issue-request',
            kind: 'ws-ticket-issued',
            ticketDigest: 'websocket-ticket-digest',
            sessionId: 'session-1',
            issuedAtEpochMs: 1_001,
            expiresAtEpochMs: 1_500
        }
    },
    {
        command: {
            version: 1,
            kind: 'consume-ws-ticket',
            requestId: 'websocket-consume-request',
            capturedAtEpochMs: 1_002,
            ticketDigest: websocketTicket.ticketDigest,
            expectedSessionId: session.sessionId
        },
        read: {
            kind: 'consume-ws-ticket',
            ticket: entry(websocketTicket, 'ticket-digest=websocket-ticket-digest'),
            session: entry(session, 'session=session-1')
        },
        result: {
            requestId: 'websocket-consume-request',
            kind: 'ws-ticket-consumed',
            ...session
        }
    },
    {
        command: {
            version: 1,
            kind: 'issue-agent-tickets',
            requestId: 'agent-issue-request',
            capturedAtEpochMs: 1_001,
            authority: session,
            tickets: [agentTicketCommand]
        },
        read: {
            kind: 'issue-agent-tickets',
            authority: emptySessionEntries,
            sessions: [emptySessionEntries],
            tickets: [null],
            expiredTicketEntries: [null]
        },
        result: {
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
        }
    },
    {
        command: {
            version: 1,
            kind: 'consume-agent-ticket',
            requestId: 'agent-consume-request',
            capturedAtEpochMs: 1_002,
            ticketDigest: agentTicket.ticketDigest
        },
        read: {
            kind: 'consume-agent-ticket',
            ticket: entry(agentTicket, 'ticket-digest=agent-ticket-digest'),
            session: entry(
                {
                    ...session,
                    sessionId: 'agent-session-1',
                    accessTokenDigest: 'agent-access-token-digest'
                },
                'session=agent-session-1'
            )
        },
        result: {
            requestId: 'agent-consume-request',
            kind: 'agent-ticket-consumed',
            clientId: 'client-1',
            username: 'alice',
            sessionId: 'agent-session-1',
            accessTokenDigest: 'agent-access-token-digest',
            issuedAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        }
    }
];

describe('auth mutation compute operation matrix', () => {
    it('preserves all seven write decisions, input identities, results, and property order', () => {
        for (const { command, read, result } of operationMatrix) {
            const computed = computeAuthMutation({
                command,
                read,
                facts: { kind: command.kind, serviceId: 'auth-service' }
            });

            expect(computed.command).toBe(command);
            expect(computed.read).toBe(read);
            expect(computed.outcome).toBe('write');
            expect(computed.result).toEqual(result);
            expect(Object.keys(computed.result)).toEqual(Object.keys(result));
            expect(Object.keys(computed)).toEqual([
                'command',
                'read',
                'sessions',
                'agentTickets',
                'logoutOutbox',
                'result',
                'outcome',
                'persistence'
            ]);
        }
    });

    it('preserves registration, session, websocket-ticket, and agent-ticket replay decisions', () => {
        for (const index of [0, 1, 3, 5]) {
            const { command, result } = operationMatrix[index];
            const read = replayRead(command);
            const computed = computeAuthMutation({
                command,
                read,
                facts: { kind: command.kind, serviceId: 'auth-service' }
            });

            expect(computed.outcome).toBe('replay');
            expect(computed.result).toEqual(result);
        }
    });
});

describe('auth mutation compute rejections', () => {
    it('preserves read-kind, facts-kind, and missing-session rejection contracts', () => {
        const register = operationMatrix[0];
        expect(() =>
            computeAuthMutation({
                command: register.command,
                read: operationMatrix[1].read,
                facts: { kind: register.command.kind, serviceId: 'auth-service' }
            })
        ).toThrow('Auth command/read operation differs');
        expect(() =>
            computeAuthMutation({
                command: register.command,
                read: register.read,
                facts: { kind: 'logout-session', serviceId: 'auth-service' }
            })
        ).toThrow('Auth command/facts operation differs');

        const websocket = operationMatrix[4];
        const websocketRead = websocket.read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket'; }>;
        const websocketRejection = catchComputeRejection(websocket.command, {
            ...websocketRead,
            session: null
        });
        expect(websocketRejection).toBeInstanceOf(AuthMutationRejectedError);
        expect(websocketRejection).toMatchObject({
            message: 'Websocket ticket session is unavailable',
            status: 404
        });

        const agent = operationMatrix[6];
        const agentRead = agent.read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket'; }>;
        const agentRejection = catchComputeRejection(agent.command, { ...agentRead, session: null });
        expect(agentRejection).toBeInstanceOf(AuthMutationRejectedError);
        expect(agentRejection).toMatchObject({
            message: 'Agent ticket session is unavailable',
            status: 404
        });
    });
});

function catchComputeRejection(command: AuthMutationCommand, read: AuthMutationRead): Error {
    try {
        computeAuthMutation({
            command,
            read,
            facts: { kind: command.kind, serviceId: 'auth-service' }
        });
    }
    catch (error) {
        if (error instanceof Error) {
            return error;
        }
        throw new TypeError('Auth compute rejected with a non-Error value');
    }
    throw new Error('Expected auth compute rejection');
}

function replayRead(command: AuthMutationCommand): AuthMutationRead {
    switch (command.kind) {
        case 'register-user':
            return {
                kind: command.kind,
                byUsername: entry(command.user, 'username=alice'),
                byClientId: entry(command.user, 'client=client-1')
            };
        case 'issue-session':
            return {
                kind: command.kind,
                userByUsername: null,
                userByClientId: null,
                byToken: entry(command.session, 'token-digest=access-token-digest'),
                bySession: entry(command.session, 'session=session-1'),
                expiredByTokenEntry: null,
                expiredBySessionEntry: null
            };
        case 'issue-ws-ticket':
            return {
                kind: command.kind,
                ticket: entry(command.ticketRecord, 'ticket-digest=websocket-ticket-digest'),
                expiredTicketEntry: null,
                session: entry(session, 'session=session-1')
            };
        case 'issue-agent-tickets': {
            const persistedSession = {
                clientId: 'client-1',
                username: 'alice',
                sessionId: 'agent-session-1',
                accessTokenDigest: 'agent-access-token-digest',
                issuedAtEpochMs: 1_001,
                expiresAtEpochMs: 2_000
            };
            return {
                kind: command.kind,
                authority: emptySessionEntries,
                sessions: [
                    {
                        byToken: entry(persistedSession, 'token-digest=agent-access-token-digest'),
                        bySession: entry(persistedSession, 'session=agent-session-1'),
                        expiredByTokenEntry: null,
                        expiredBySessionEntry: null
                    }
                ],
                tickets: [entry(agentTicket, 'ticket-digest=agent-ticket-digest')],
                expiredTicketEntries: [null]
            };
        }
        default:
            throw new Error(`No replay fixture for ${command.kind}`);
    }
}

function entry<T>(value: T, key: string) {
    return {
        entry: {
            key,
            value: JSON.stringify(value),
            expireAtTimestamp: 2_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 0
        },
        value
    };
}
