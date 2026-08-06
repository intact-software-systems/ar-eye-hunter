import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import {
    decodePersistedAuthSession,
    type PersistedAgentSessionTicket,
    type PersistedAuthSession,
} from '../repositories/AuthSessionRepository.ts';
import type { AuthUser } from '../repositories/AuthUserRepository.ts';
import { AuthMutationRejectedError } from '../auth/mutation/auth-mutation-rejected-error.ts';
import type {
    AuthComputedSession,
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationFacts,
    AuthMutationRead,
    AuthMutationResult,
    LogoutAuthSessionCommand,
} from '../auth/mutation/auth-mutation-contracts.ts';
import { requireIssueSessionLifecycle } from '../auth/sessions/require-auth-session-lifecycle.ts';
import { toAppQueueCreatedBy } from './app-inbox-queue-key.ts';
import {
    equalAuthJson,
    requireAuthTicket,
    requireMatchingAuthKind,
} from './auth-state-validation-shared.ts';

export function computeAuthMutation(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    facts: AuthMutationFacts,
    serviceId: string,
): AuthMutationComputed {
    requireMatchingAuthKind(command, read);
    requireMatchingFacts(command, facts);
    const common = {
        command,
        read,
        sessions: [] as readonly AuthComputedSession[],
        agentTickets: [] as readonly PersistedAgentSessionTicket[],
        logoutOutbox: null,
    };
    switch (command.kind) {
        case 'register-user':
            return {
                ...common,
                result: {
                    requestId: command.requestId,
                    clientId: command.user.clientId,
                    username: command.user.username,
                    displayName: command.user.displayName,
                    registeredAtEpochMs: command.user.createdAtEpochMs,
                },
                outcome: isMatchingUserRead(read, command.user) ? 'replay' : 'write',
            };
        case 'issue-session': {
            const session = decodePersistedAuthSession(command.session);
            requireIssueSessionLifecycle(command.capturedAtEpochMs, session);
            return {
                ...common,
                sessions: [{ session }],
                result: toSessionReceipt(session, command.requestId),
                outcome: isMatchingSessionRead(read, session) ? 'replay' : 'write',
            };
        }
        case 'logout-session': {
            const logoutRead = read as Extract<AuthMutationRead, { kind: 'logout-session' }>;
            return {
                ...common,
                result: { requestId: command.requestId, loggedOut: true },
                outcome: logoutRead.bySession === null && logoutRead.byToken === null
                    ? 'no-op'
                    : 'write',
                logoutOutbox: logoutRead.bySession ? toLogoutWsOutbox(command, serviceId) : null,
            };
        }
        case 'issue-ws-ticket': {
            const ticketRead = read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>;
            return {
                ...common,
                result: {
                    requestId: command.requestId,
                    kind: 'ws-ticket-issued',
                    ticketDigest: command.ticketRecord.ticketDigest,
                    sessionId: command.ticketRecord.sessionId,
                    issuedAtEpochMs: command.ticketRecord.issuedAtEpochMs,
                    expiresAtEpochMs: command.ticketRecord.expiresAtEpochMs,
                },
                outcome: ticketRead.ticket &&
                        equalAuthJson(ticketRead.ticket.value, command.ticketRecord)
                    ? 'replay'
                    : 'write',
            };
        }
        case 'consume-ws-ticket': {
            const consumeRead = read as Extract<
                AuthMutationRead,
                { kind: 'consume-ws-ticket' }
            >;
            const ticket = requireAuthTicket(consumeRead.ticket);
            return {
                ...common,
                result: toConsumedSessionReceipt(
                    'ws-ticket-consumed',
                    command.requestId,
                    requireSession(
                        consumeRead.session,
                        'Websocket ticket session is unavailable',
                    ),
                    ticket.value.accessTokenDigest,
                ),
                outcome: 'write',
            };
        }
        case 'issue-agent-tickets': {
            const agentRead = read as Extract<
                AuthMutationRead,
                { kind: 'issue-agent-tickets' }
            >;
            const issuedSessions: AuthComputedSession[] = [];
            const persistedTickets: PersistedAgentSessionTicket[] = [];
            const responseTickets = [];
            for (const ticket of command.tickets) {
                issuedSessions.push({
                    session: decodePersistedAuthSession({
                        clientId: ticket.clientId,
                        username: ticket.username,
                        sessionId: ticket.sessionId,
                        accessTokenDigest: ticket.accessTokenDigest,
                        issuedAtEpochMs: ticket.issuedAtEpochMs,
                        expiresAtEpochMs: ticket.sessionExpiresAtEpochMs,
                    }),
                });
                persistedTickets.push({
                    ticketDigest: ticket.ticketDigest,
                    accessTokenDigest: ticket.accessTokenDigest,
                    sessionId: ticket.sessionId,
                    clientId: ticket.clientId,
                    agentId: ticket.agentId,
                    issuedAtEpochMs: ticket.issuedAtEpochMs,
                    expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
                });
                responseTickets.push({
                    agentId: ticket.agentId,
                    ticketDigest: ticket.ticketDigest,
                    sessionId: ticket.sessionId,
                    issuedAtEpochMs: ticket.issuedAtEpochMs,
                    expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
                });
            }
            return {
                ...common,
                sessions: issuedSessions,
                agentTickets: persistedTickets,
                result: {
                    requestId: command.requestId,
                    kind: 'agent-tickets-issued',
                    tickets: responseTickets,
                },
                outcome: isMatchingAgentIssueRead(
                        agentRead,
                        issuedSessions,
                        persistedTickets,
                    )
                    ? 'replay'
                    : 'write',
            };
        }
        case 'consume-agent-ticket': {
            const consumeRead = read as Extract<
                AuthMutationRead,
                { kind: 'consume-agent-ticket' }
            >;
            const ticket = requireAuthTicket(consumeRead.ticket);
            return {
                ...common,
                result: toConsumedSessionReceipt(
                    'agent-ticket-consumed',
                    command.requestId,
                    requireSession(
                        consumeRead.session,
                        'Agent ticket session is unavailable',
                    ),
                    ticket.value.accessTokenDigest,
                ),
                outcome: 'write',
            };
        }
    }
}

function isMatchingUserRead(read: AuthMutationRead, user: AuthUser): boolean {
    return read.kind === 'register-user' &&
        read.byUsername !== null && read.byClientId !== null &&
        equalAuthJson(read.byUsername.value, user) &&
        equalAuthJson(read.byClientId.value, user);
}

function isMatchingSessionRead(
    read: AuthMutationRead,
    session: PersistedAuthSession,
): boolean {
    return (read.kind === 'issue-session' || read.kind === 'logout-session') &&
        read.byToken !== null && read.bySession !== null &&
        equalAuthJson(read.byToken.value, session) &&
        equalAuthJson(read.bySession.value, session);
}

function isMatchingAgentIssueRead(
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
    sessions: readonly AuthComputedSession[],
    tickets: readonly PersistedAgentSessionTicket[],
): boolean {
    return read.sessions.length === sessions.length && read.tickets.length === tickets.length &&
        sessions.every((computed, index) =>
            read.sessions[index].byToken !== null &&
            read.sessions[index].bySession !== null &&
            equalAuthJson(read.sessions[index].byToken?.value, computed.session) &&
            equalAuthJson(read.sessions[index].bySession?.value, computed.session) &&
            read.tickets[index] !== null &&
            equalAuthJson(read.tickets[index]?.value, tickets[index])
        );
}

function requireMatchingFacts(
    command: AuthMutationCommand,
    facts: AuthMutationFacts,
): void {
    if (facts.kind !== command.kind) {
        throw new AuthMutationRejectedError('Auth command/facts operation differs');
    }
}

function requireSession(
    entry: RuntimeStateEntryValue<PersistedAuthSession> | null,
    message: string,
): PersistedAuthSession {
    if (!entry) throw new AuthMutationRejectedError(message, 404);
    return entry.value;
}

function toSessionReceipt(
    session: PersistedAuthSession,
    requestId: string,
): Extract<AuthMutationResult, { kind: 'session-issued' }> {
    return {
        requestId,
        kind: 'session-issued',
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: session.accessTokenDigest,
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}

function toConsumedSessionReceipt(
    kind: 'ws-ticket-consumed' | 'agent-ticket-consumed',
    requestId: string,
    session: PersistedAuthSession,
    accessTokenDigest: string,
): Extract<AuthMutationResult, { kind: typeof kind }> {
    return {
        requestId,
        kind,
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest,
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}

function toLogoutWsOutbox(
    command: LogoutAuthSessionCommand,
    serviceId: string,
): ResourceEntry {
    const message = {
        id: {
            v: 2,
            msgId: `auth-logout:${command.requestId}`,
            ts: command.capturedAtEpochMs,
            senderId: serviceId,
        },
        route: {
            topicId: 'auth.session.logout',
            resourceId: command.requestId,
            contextId: command.expected.sessionId,
        },
        targets: { mode: 'unicast', toPeerId: command.expected.sessionId },
        constraints: { expiresAtMs: command.expected.expiresAtEpochMs },
        payload: {
            typeId: 'auth.session.logout.v1',
            contentType: 'application/json',
            resource: JSON.stringify({
                sessionId: command.expected.sessionId,
                closeCode: 1000,
                reason: 'auth-logout',
            }),
        },
        audit: { createdBy: serviceId, createdTs: command.capturedAtEpochMs },
    } as const;
    const createdTs = Temporal.Instant
        .fromEpochMilliseconds(command.capturedAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: message.route,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.WS_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(serviceId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                command.expected.expiresAtEpochMs,
            ),
        },
        dequeueAudit: { attempts: 0 },
    };
}
