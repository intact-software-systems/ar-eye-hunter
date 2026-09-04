import { describe, expect, it } from 'vitest';

import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationDomainComputed,
    AuthMutationRead
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { computeAuthPersistence } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-persistence.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';

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
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 1_500
} as const;
const agentTicketCommand = {
    agentId: 'agent-1',
    sessionId: 'agent-session-1',
    accessTokenDigest: 'agent-access-token-digest',
    ticketDigest: 'agent-ticket-digest',
    clientId: session.clientId,
    username: session.username,
    issuedAtEpochMs: 1_000,
    sessionExpiresAtEpochMs: 2_000,
    ticketExpiresAtEpochMs: 1_500
} as const;
const persistedAgentTicket = {
    ticketDigest: agentTicketCommand.ticketDigest,
    accessTokenDigest: agentTicketCommand.accessTokenDigest,
    sessionId: agentTicketCommand.sessionId,
    clientId: agentTicketCommand.clientId,
    agentId: agentTicketCommand.agentId,
    issuedAtEpochMs: agentTicketCommand.issuedAtEpochMs,
    expiresAtEpochMs: agentTicketCommand.ticketExpiresAtEpochMs
} as const;
const agentSession = {
    ...session,
    sessionId: agentTicketCommand.sessionId,
    accessTokenDigest: agentTicketCommand.accessTokenDigest
} as const;
const emptySessionEntries = {
    byToken: null,
    bySession: null,
    expiredByTokenEntry: null,
    expiredBySessionEntry: null
} as const;

interface AuthMutationCase {
    readonly command: AuthMutationCommand;
    readonly read: AuthMutationRead;
}

describe('auth mutation validation', () => {
    it('accepts the computed decision for every command family', () => {
        for (const { command, read } of authMutationCases()) {
            const computed = computeAuth(command, read);

            expect(
                () =>
                    validateAuthMutation({
                        command,
                        read,
                        facts: authFacts(command),
                        computed
                    }),
                command.kind
            ).not.toThrow();
            expect(computed.command).toBe(command);
            expect(computed.read).toBe(read);
        }
    });

    it.each(validationRejectionCases())(
        'preserves the $label rejection',
        ({ command, read, computed, message, status }) => {
            const rejection = captureRejection(() =>
                validateAuthMutation({
                    command,
                    read,
                    facts: authFacts(command),
                    computed
                })
            );

            expect(rejection).toBeInstanceOf(AuthMutationRejectedError);
            expect(rejection).toMatchObject({ message, status, code: 'auth-mutation-rejected' });
        }
    );

    it.each(computedTamperCases())(
        'rejects a self-consistent $label tamper',
        ({ command, read, computed }) => {
            expect(() =>
                validateAuthMutation({
                    command,
                    read,
                    facts: authFacts(command),
                    computed
                })
            ).toThrow('Auth computed value differs');
        }
    );
});

function computedTamperCases() {
    const issueSession = registrationAndSessionCases()[1];
    const issueSessionComputed = computeAuth(issueSession.command, issueSession.read);
    const computedSession = issueSessionComputed.sessions[0]?.session;
    if (!computedSession) {
        throw new Error('Missing computed session tamper fixture');
    }
    const issueAgentTickets = agentTicketCases()[0];
    const issueAgentTicketsComputed = computeAuth(
        issueAgentTickets.command,
        issueAgentTickets.read
    );
    const computedAgentTicket = issueAgentTicketsComputed.agentTickets[0];
    if (!computedAgentTicket) {
        throw new Error('Missing computed agent ticket tamper fixture');
    }
    const logoutCommand = registrationAndSessionCases()[2].command as Extract<AuthMutationCommand, { kind: 'logout-session'; }>;
    const logoutRead = {
        kind: 'logout-session',
        ...matchingSessionEntries(session)
    } as const;
    const logoutComputed = computeAuth(logoutCommand, logoutRead);
    const logoutOutbox = logoutComputed.logoutOutbox;
    const persistedLogoutOutbox = logoutComputed.persistence.logoutOutbox;
    if (!logoutOutbox || !persistedLogoutOutbox) {
        throw new Error('Missing logout outbox tamper fixture');
    }
    const alteredLogoutOutbox = {
        ...logoutOutbox,
        resource: '{"tampered":true}'
    };

    return [
        {
            label: 'result',
            command: issueSession.command,
            read: issueSession.read,
            computed: {
                ...issueSessionComputed,
                result: { ...issueSessionComputed.result, requestId: 'forged-request' }
            }
        },
        {
            label: 'outcome',
            command: issueSession.command,
            read: issueSession.read,
            computed: withRecomputedPersistence(issueSessionComputed, { outcome: 'no-op' })
        },
        {
            label: 'session',
            command: issueSession.command,
            read: issueSession.read,
            computed: withRecomputedPersistence(issueSessionComputed, {
                sessions: [{ session: { ...computedSession, username: 'mallory' } }]
            })
        },
        {
            label: 'agent ticket',
            command: issueAgentTickets.command,
            read: issueAgentTickets.read,
            computed: withRecomputedPersistence(issueAgentTicketsComputed, {
                agentTickets: [{ ...computedAgentTicket, agentId: 'forged-agent' }]
            })
        },
        {
            label: 'raw logout outbox',
            command: logoutCommand,
            read: logoutRead,
            computed: withRecomputedPersistence(logoutComputed, {
                logoutOutbox: alteredLogoutOutbox
            })
        },
        {
            label: 'persistence conflict',
            command: logoutCommand,
            read: logoutRead,
            computed: {
                ...logoutComputed,
                persistence: {
                    ...logoutComputed.persistence,
                    logoutOutbox: {
                        ...persistedLogoutOutbox,
                        conflict: new ResourceInboxInvariantCorruptionError(
                            persistedLogoutOutbox.entry.key,
                            'Forged persistence conflict'
                        )
                    }
                }
            }
        }
    ];
}

function withRecomputedPersistence(
    computed: AuthMutationComputed,
    changes: Partial<AuthMutationDomainComputed>
): AuthMutationComputed {
    const altered = { ...computed, ...changes };
    return {
        ...altered,
        persistence: computeAuthPersistence(altered, altered.command.kind)
    };
}

function authMutationCases(): readonly AuthMutationCase[] {
    return [...registrationAndSessionCases(), ...webSocketTicketCases(), ...agentTicketCases()];
}

function registrationAndSessionCases(): readonly AuthMutationCase[] {
    return [
        {
            command: {
                version: 1,
                kind: 'register-user',
                requestId: 'register-request',
                capturedAtEpochMs: 1_000,
                user
            },
            read: { kind: 'register-user', byUsername: null, byClientId: null }
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
            }
        },
        {
            command: {
                version: 1,
                kind: 'logout-session',
                requestId: 'logout-request',
                capturedAtEpochMs: 1_000,
                expected: session
            },
            read: { kind: 'logout-session', ...emptySessionEntries }
        }
    ];
}

function webSocketTicketCases(): readonly AuthMutationCase[] {
    return [
        {
            command: {
                version: 1,
                kind: 'issue-ws-ticket',
                requestId: 'websocket-issue-request',
                capturedAtEpochMs: 1_000,
                ticketRecord: websocketTicket
            },
            read: {
                kind: 'issue-ws-ticket',
                ticket: null,
                expiredTicketEntry: null,
                session: entry(session, 'session=session-1')
            }
        },
        {
            command: {
                version: 1,
                kind: 'consume-ws-ticket',
                requestId: 'websocket-consume-request',
                capturedAtEpochMs: 1_000,
                ticketDigest: websocketTicket.ticketDigest,
                expectedSessionId: session.sessionId
            },
            read: {
                kind: 'consume-ws-ticket',
                ticket: entry(websocketTicket, 'ticket=websocket-ticket-digest'),
                session: entry(session, 'session=session-1')
            }
        }
    ];
}

function agentTicketCases(): readonly AuthMutationCase[] {
    return [
        {
            command: {
                version: 1,
                kind: 'issue-agent-tickets',
                requestId: 'agent-issue-request',
                capturedAtEpochMs: 1_000,
                authority: session,
                tickets: [agentTicketCommand]
            },
            read: {
                kind: 'issue-agent-tickets',
                authority: matchingSessionEntries(session),
                sessions: [emptySessionEntries],
                tickets: [null],
                expiredTicketEntries: [null]
            }
        },
        {
            command: {
                version: 1,
                kind: 'consume-agent-ticket',
                requestId: 'agent-consume-request',
                capturedAtEpochMs: 1_000,
                ticketDigest: persistedAgentTicket.ticketDigest
            },
            read: {
                kind: 'consume-agent-ticket',
                ticket: entry(persistedAgentTicket, 'ticket=agent-ticket-digest'),
                session: entry(agentSession, 'session=agent-session-1')
            }
        }
    ];
}

function validationRejectionCases() {
    const cases = authMutationCases();
    return [
        ...registrationAndSessionRejectionCases(cases),
        ...webSocketTicketRejectionCases(cases),
        ...agentTicketRejectionCases(cases)
    ];
}

function registrationAndSessionRejectionCases(cases: readonly AuthMutationCase[]) {
    const registration = cases[0];
    const issueSession = cases[1];
    const logout = cases[2];
    const staticUserRead = {
        ...issueSession.read,
        userByUsername: entry(user, 'username=alice'),
        userByClientId: entry(user, 'client=client-1')
    } as Extract<AuthMutationRead, { kind: 'issue-session'; }>;

    return [
        rejectionCase({
            label: 'registration username collision',
            command: registration.command,
            read: {
                ...registration.read,
                byUsername: entry({ ...user, clientId: 'different-client' }, 'username=alice')
            } as AuthMutationRead,
            message: 'Auth username already exists',
            status: 409
        }),
        rejectionCase({
            label: 'static session authority conflict',
            command: issueSession.command,
            read: staticUserRead,
            message: 'Static auth session authority conflicts with a registered user',
            status: 403
        }),
        rejectionCase({
            label: 'logout index corruption',
            command: logout.command,
            read: { ...logout.read, bySession: entry(session, 'session=session-1') } as AuthMutationRead,
            message: 'Auth logout indexes are inconsistent',
            status: 500
        })
    ];
}

function webSocketTicketRejectionCases(cases: readonly AuthMutationCase[]) {
    const issueWebSocket = cases[3];
    const consumeWebSocket = cases[4];
    const expiredWebSocketCommand = {
        ...issueWebSocket.command,
        ticketRecord: { ...websocketTicket, expiresAtEpochMs: 1_000 }
    } as AuthMutationCommand;
    const missingWebSocketTicketRead = { ...consumeWebSocket.read, ticket: null } as AuthMutationRead;

    return [
        rejectionCase({
            label: 'websocket ticket expiry',
            command: expiredWebSocketCommand,
            read: issueWebSocket.read,
            message: 'Websocket ticket is expired',
            status: 410
        }),
        rejectionCase({
            label: 'consumed websocket ticket absence',
            command: consumeWebSocket.command,
            read: missingWebSocketTicketRead,
            message: 'Auth ticket is invalid or consumed',
            status: 404,
            computed: computeAuth(consumeWebSocket.command, consumeWebSocket.read)
        })
    ];
}

function agentTicketRejectionCases(cases: readonly AuthMutationCase[]) {
    const issueAgent = cases[5];
    const consumeAgent = cases[6];
    const duplicateAgentCommand = {
        ...issueAgent.command,
        tickets: [agentTicketCommand, agentTicketCommand]
    } as AuthMutationCommand;
    const duplicateAgentRead = {
        ...issueAgent.read,
        sessions: [emptySessionEntries, emptySessionEntries],
        tickets: [null, null],
        expiredTicketEntries: [null, null]
    } as AuthMutationRead;
    const missingAgentTicketRead = { ...consumeAgent.read, ticket: null } as AuthMutationRead;

    return [
        rejectionCase({
            label: 'agent ticket duplicate identity',
            command: duplicateAgentCommand,
            read: duplicateAgentRead,
            message: 'Agent ticket batch identity is duplicated',
            status: 409
        }),
        rejectionCase({
            label: 'consumed agent ticket absence',
            command: consumeAgent.command,
            read: missingAgentTicketRead,
            message: 'Auth ticket is invalid or consumed',
            status: 404,
            computed: computeAuth(consumeAgent.command, consumeAgent.read)
        })
    ];
}

interface RejectionCaseInput {
    readonly label: string;
    readonly command: AuthMutationCommand;
    readonly read: AuthMutationRead;
    readonly message: string;
    readonly status: number;
    readonly computed?: AuthMutationComputed;
}

function rejectionCase({
    label,
    command,
    read,
    message,
    status,
    computed = computeAuth(command, read)
}: RejectionCaseInput) {
    return {
        label,
        command,
        read,
        computed: computed.command === command && computed.read === read
            ? computed
            : { ...computed, command, read },
        message,
        status
    };
}

function computeAuth(command: AuthMutationCommand, read: AuthMutationRead) {
    return computeAuthMutation({
        command,
        read,
        facts: authFacts(command)
    });
}

function authFacts(command: AuthMutationCommand) {
    return { kind: command.kind, serviceId: 'auth-service' } as const;
}

function captureRejection(callback: () => void): Error {
    try {
        callback();
    }
    catch (error) {
        return error instanceof Error
            ? error
            : new TypeError('Auth validation rejected with a non-Error value');
    }
    throw new Error('Expected auth validation rejection');
}

function matchingSessionEntries(value: typeof session) {
    return {
        byToken: entry(value, 'token-digest=access-token-digest'),
        bySession: entry(value, 'session=session-1'),
        expiredByTokenEntry: null,
        expiredBySessionEntry: null
    };
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
