import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../../runtime-state/RuntimeStateRepository.ts';
import type { AuthSessionRepository, PersistedAgentSessionTicket } from '../../persistence/auth-session-repository.ts';
import type { AuthUserRepository } from '../../persistence/auth-user-repository.ts';
import type { AuthMutationCommand, AuthMutationRead, AuthSessionEntries } from '../auth-mutation-contracts.ts';
import { readAuthSessionEntries } from './read-auth-session-entries.ts';

type AuthUserRegistrationRead = Extract<AuthMutationRead, { kind: 'register-user'; }>;
type AuthSessionIssueRead = Extract<AuthMutationRead, { kind: 'issue-session'; }>;
type AuthWebSocketTicketIssueRead = Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>;
type AuthWebSocketTicketConsumeRead = Extract<AuthMutationRead, { kind: 'consume-ws-ticket'; }>;
type AuthAgentTicketsIssueRead = Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>;
type AuthAgentTicketConsumeRead = Extract<AuthMutationRead, { kind: 'consume-agent-ticket'; }>;

export async function readAuthMutation(
    users: AuthUserRepository,
    sessions: AuthSessionRepository,
    command: AuthMutationCommand
): Promise<AuthMutationRead> {
    switch (command.kind) {
        case 'register-user':
            return await readAuthUserRegistration(users, command);
        case 'issue-session':
            return await readAuthSessionIssue(users, sessions, command);
        case 'logout-session':
            return { kind: command.kind, ...(await readAuthSessionEntries(sessions, command.expected)) };
        case 'issue-ws-ticket':
            return await readAuthWebSocketTicketIssue(sessions, command);
        case 'consume-ws-ticket':
            return await readAuthWebSocketTicketConsume(sessions, command);
        case 'issue-agent-tickets':
            return await readAuthAgentTicketsIssue(sessions, command);
        case 'consume-agent-ticket':
            return await readAuthAgentTicketConsume(sessions, command);
    }
}

async function readAuthUserRegistration(
    users: AuthUserRepository,
    command: Extract<AuthMutationCommand, { kind: 'register-user'; }>
): Promise<AuthUserRegistrationRead> {
    return {
        kind: command.kind,
        byUsername: (await users.findByNormalizedUsernameEntry(command.user.normalizedUsername)) ?? null,
        byClientId: (await users.findByClientIdEntry(command.user.clientId)) ?? null
    };
}

async function readAuthSessionIssue(
    users: AuthUserRepository,
    sessions: AuthSessionRepository,
    command: Extract<AuthMutationCommand, { kind: 'issue-session'; }>
): Promise<AuthSessionIssueRead> {
    const byToken = await sessions.readSessionByAccessTokenDigestEntry(
        command.session.accessTokenDigest
    );
    const bySession = await sessions.readSessionBySessionIdEntry(command.session.sessionId);
    return {
        kind: command.kind,
        userByUsername: (await users.findByNormalizedUsernameEntry(command.authority.normalizedUsername)) ?? null,
        userByClientId: (await users.findByClientIdEntry(command.authority.clientId)) ?? null,
        byToken: byToken.value ?? null,
        bySession: bySession.value ?? null,
        expiredByTokenEntry: byToken.expiredEntry ?? null,
        expiredBySessionEntry: bySession.expiredEntry ?? null
    };
}

async function readAuthWebSocketTicketIssue(
    sessions: AuthSessionRepository,
    command: Extract<AuthMutationCommand, { kind: 'issue-ws-ticket'; }>
): Promise<AuthWebSocketTicketIssueRead> {
    const ticket = await sessions.readWebSocketTicketByDigestEntry(command.ticketRecord.ticketDigest);
    const session = (await sessions.findSessionBySessionIdEntry(command.ticketRecord.sessionId)) ?? null;
    return {
        kind: command.kind,
        ticket: ticket.value ?? null,
        expiredTicketEntry: ticket.expiredEntry ?? null,
        session
    };
}

async function readAuthWebSocketTicketConsume(
    sessions: AuthSessionRepository,
    command: Extract<AuthMutationCommand, { kind: 'consume-ws-ticket'; }>
): Promise<AuthWebSocketTicketConsumeRead> {
    const ticket = (await sessions.findWebSocketTicketByDigestEntry(command.ticketDigest)) ?? null;
    return {
        kind: command.kind,
        ticket,
        session: ticket
            ? ((await sessions.findSessionBySessionIdEntry(ticket.value.sessionId)) ?? null)
            : null
    };
}

async function readAuthAgentTicketsIssue(
    sessions: AuthSessionRepository,
    command: Extract<AuthMutationCommand, { kind: 'issue-agent-tickets'; }>
): Promise<AuthAgentTicketsIssueRead> {
    const sessionEntries: AuthSessionEntries[] = [];
    const ticketEntries: Array<RuntimeStateEntryValue<PersistedAgentSessionTicket> | null> = [];
    const expiredTicketEntries: Array<RuntimeStateEntry | null> = [];
    for (const ticket of command.tickets) {
        sessionEntries.push(await readAuthSessionEntries(sessions, ticket));
        const ticketRead = await sessions.readAgentSessionTicketByDigestEntry(ticket.ticketDigest);
        ticketEntries.push(ticketRead.value ?? null);
        expiredTicketEntries.push(ticketRead.expiredEntry ?? null);
    }
    return {
        kind: command.kind,
        authority: await readAuthSessionEntries(sessions, command.authority),
        sessions: sessionEntries,
        tickets: ticketEntries,
        expiredTicketEntries
    };
}

async function readAuthAgentTicketConsume(
    sessions: AuthSessionRepository,
    command: Extract<AuthMutationCommand, { kind: 'consume-agent-ticket'; }>
): Promise<AuthAgentTicketConsumeRead> {
    const ticket = (await sessions.findAgentSessionTicketByDigestEntry(command.ticketDigest)) ?? null;
    return {
        kind: command.kind,
        ticket,
        session: ticket
            ? ((await sessions.findSessionBySessionIdEntry(ticket.value.sessionId)) ?? null)
            : null
    };
}
