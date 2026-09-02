import { decodePersistedAuthSession } from '../../persistence/persisted-auth-session.ts';
import type { PersistedAgentSessionTicket } from '../../persistence/persisted-auth-ticket.ts';
import type {
    AuthComputedSession,
    AuthMutationCommand,
    AuthMutationDomainComputed,
    AuthMutationRead,
    IssueAuthAgentTicketsCommand
} from '../auth-mutation-contracts.ts';
import { equalAuthJson, requireAuthTicket } from '../validate/auth-mutation-validation.ts';
import { requireConsumedAuthSession, toConsumedAuthSessionResult } from './compute-auth-session-mutation.ts';

type AuthAgentTicketMutationCommand = Extract<
    AuthMutationCommand,
    { kind: 'issue-agent-tickets' | 'consume-agent-ticket'; }
>;

interface ComputeAuthAgentTicketMutationInput {
    readonly kind: AuthAgentTicketMutationCommand['kind'];
    readonly command: AuthAgentTicketMutationCommand;
    readonly read: AuthMutationRead;
}

interface AuthAgentTicketComputation {
    readonly session: AuthComputedSession;
    readonly agentTicket: PersistedAgentSessionTicket;
    readonly resultTicket: Readonly<{
        agentId: string;
        ticketDigest: string;
        sessionId: string;
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;
}

export function computeAuthAgentTicketMutation(
    input: ComputeAuthAgentTicketMutationInput
): AuthMutationDomainComputed {
    switch (input.kind) {
        case 'issue-agent-tickets':
            return computeIssueAuthAgentTickets(
                input.command as IssueAuthAgentTicketsCommand,
                input.read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>
            );
        case 'consume-agent-ticket': {
            const command = input.command as Extract<AuthMutationCommand, { kind: 'consume-agent-ticket'; }>;
            const consumeRead = input.read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket'; }>;
            const ticket = requireAuthTicket(consumeRead.ticket);
            const requestId = command.requestId;
            const session = requireConsumedAuthSession(
                consumeRead.session,
                'Agent ticket session is unavailable'
            );
            const accessTokenDigest = ticket.value.accessTokenDigest;
            return {
                command,
                read: input.read,
                sessions: [],
                agentTickets: [],
                logoutOutbox: null,
                result: toConsumedAuthSessionResult({
                    kind: 'agent-ticket-consumed',
                    requestId,
                    session,
                    accessTokenDigest
                }),
                outcome: 'write'
            };
        }
    }
}

function computeIssueAuthAgentTickets(
    command: IssueAuthAgentTicketsCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>
): AuthMutationDomainComputed {
    const ticketComputations = command.tickets.map(toAuthAgentTicketComputation);
    const sessions = ticketComputations.map(({ session }) => session);
    const agentTickets = ticketComputations.map(({ agentTicket }) => agentTicket);
    return {
        command,
        read,
        sessions,
        agentTickets,
        logoutOutbox: null,
        result: {
            requestId: command.requestId,
            kind: 'agent-tickets-issued',
            tickets: ticketComputations.map(({ resultTicket }) => resultTicket)
        },
        outcome: isMatchingAgentIssueRead(read, sessions, agentTickets) ? 'replay' : 'write'
    };
}

function toAuthAgentTicketComputation(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number]
): AuthAgentTicketComputation {
    const session = {
        session: decodePersistedAuthSession({
            clientId: ticket.clientId,
            username: ticket.username,
            sessionId: ticket.sessionId,
            accessTokenDigest: ticket.accessTokenDigest,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.sessionExpiresAtEpochMs
        })
    };
    const agentTicket = {
        ticketDigest: ticket.ticketDigest,
        accessTokenDigest: ticket.accessTokenDigest,
        sessionId: ticket.sessionId,
        clientId: ticket.clientId,
        agentId: ticket.agentId,
        issuedAtEpochMs: ticket.issuedAtEpochMs,
        expiresAtEpochMs: ticket.ticketExpiresAtEpochMs
    };
    const resultTicket = {
        agentId: ticket.agentId,
        ticketDigest: ticket.ticketDigest,
        sessionId: ticket.sessionId,
        issuedAtEpochMs: ticket.issuedAtEpochMs,
        expiresAtEpochMs: ticket.ticketExpiresAtEpochMs
    };
    return { session, agentTicket, resultTicket };
}

function isMatchingAgentIssueRead(
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets'; }>,
    sessions: readonly AuthComputedSession[],
    tickets: readonly PersistedAgentSessionTicket[]
): boolean {
    return (
        read.sessions.length === sessions.length &&
        read.tickets.length === tickets.length &&
        sessions.every(
            (computed, index) =>
                read.sessions[index].byToken !== null &&
                read.sessions[index].bySession !== null &&
                equalAuthJson(read.sessions[index].byToken?.value, computed.session) &&
                equalAuthJson(read.sessions[index].bySession?.value, computed.session) &&
                read.tickets[index] !== null &&
                equalAuthJson(read.tickets[index]?.value, tickets[index])
        )
    );
}
