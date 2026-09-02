import { decodePersistedAuthSession } from '../../persistence/persisted-auth-session.ts';
import type { PersistedAgentSessionTicket } from '../../persistence/persisted-auth-ticket.ts';
import type {
    AuthComputedSession,
    AuthComputedTicketWrite,
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    AuthSessionEntries,
    IssueAuthAgentTicketsCommand
} from '../auth-mutation-contracts.ts';
import { equalAuthJson, requireAuthTicket } from '../validate/auth-mutation-validation.ts';
import {
    computeAuthSessionWrite,
    requireConsumedAuthSession,
    toConsumedAuthSessionResult
} from './compute-auth-session-mutation.ts';
import { computeAuthAgentTicketWrite } from './compute-auth-ticket-write.ts';

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
    readonly ticketWrite: AuthComputedTicketWrite;
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
): AuthMutationComputed {
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
                kind: 'consume-agent-ticket',
                command,
                read: consumeRead,
                sessions: [],
                agentTickets: [],
                logoutDeletion: null,
                logoutOutbox: null,
                ticketDeletion: { storageKey: ticket.entry.key, expectedRevision: ticket.entry.revision },
                ticketWrites: [],
                userRegistration: null,
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
): AuthMutationComputed {
    const ticketComputations = command.tickets.map((ticket, index) =>
        toAuthAgentTicketComputation(
            ticket,
            read.sessions[index],
            read.expiredTicketEntries[index]?.revision ?? null
        )
    );
    const sessions = ticketComputations.map(({ session }) => session);
    const agentTickets = ticketComputations.map(({ agentTicket }) => agentTicket);
    const ticketWrites = ticketComputations.map(({ ticketWrite }) => ticketWrite);
    return {
        kind: 'issue-agent-tickets',
        command,
        read,
        sessions,
        agentTickets,
        logoutDeletion: null,
        logoutOutbox: null,
        ticketDeletion: null,
        ticketWrites,
        userRegistration: null,
        result: {
            requestId: command.requestId,
            kind: 'agent-tickets-issued',
            tickets: ticketComputations.map(({ resultTicket }) => resultTicket)
        },
        outcome: isMatchingAgentIssueRead(read, sessions, agentTickets) ? 'replay' : 'write'
    };
}

export function computeAuthAgentSessionWrite(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number],
    read: AuthSessionEntries
): AuthComputedSession {
    return computeAuthSessionWrite(
        decodePersistedAuthSession({
            clientId: ticket.clientId,
            username: ticket.username,
            sessionId: ticket.sessionId,
            accessTokenDigest: ticket.accessTokenDigest,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.sessionExpiresAtEpochMs
        }),
        read
    );
}

export function computeAuthAgentTicket(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number]
): PersistedAgentSessionTicket {
    return {
        ticketDigest: ticket.ticketDigest,
        accessTokenDigest: ticket.accessTokenDigest,
        sessionId: ticket.sessionId,
        clientId: ticket.clientId,
        issuedAtEpochMs: ticket.issuedAtEpochMs,
        expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
        agentId: ticket.agentId
    };
}

function toAuthAgentTicketComputation(
    ticket: IssueAuthAgentTicketsCommand['tickets'][number],
    read: AuthSessionEntries,
    expectedTicketRevision: number | null
): AuthAgentTicketComputation {
    const session = computeAuthAgentSessionWrite(ticket, read);
    const agentTicket = computeAuthAgentTicket(ticket);
    const resultTicket = {
        agentId: ticket.agentId,
        ticketDigest: ticket.ticketDigest,
        sessionId: ticket.sessionId,
        issuedAtEpochMs: ticket.issuedAtEpochMs,
        expiresAtEpochMs: ticket.ticketExpiresAtEpochMs
    };
    const ticketWrite = computeAuthAgentTicketWrite(
        agentTicket,
        expectedTicketRevision
    );
    return { session, agentTicket, ticketWrite, resultTicket };
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
