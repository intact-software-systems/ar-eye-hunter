import type {
    AuthMutationComputed,
    AuthMutationRead,
    ConsumeAuthAgentTicketCommand,
    IssueAuthAgentTicketsCommand,
} from './auth-state-contracts.ts';
import { AuthMutationRejectedError } from './auth-state-errors.ts';
import {
    equalAuthJson,
    requireAuthTicket,
    validateIssueSessionRead,
    validateLiveSessionAuthority,
} from './auth-state-validation-shared.ts';

export function validateAgentIssueRead(
    command: IssueAuthAgentTicketsCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
    computed: AuthMutationComputed,
): void {
    if (command.tickets.length === 0 || command.tickets.length !== computed.sessions.length) {
        throw new AuthMutationRejectedError('Agent ticket batch is invalid');
    }
    validateLiveSessionAuthority(
        command.authority,
        read.authority,
        command.capturedAtEpochMs,
        'Agent ticket authority',
    );
    const seenAgentIds = new Set<string>();
    const seenSessionIds = new Set<string>();
    const seenTicketDigests = new Set<string>();
    for (let index = 0; index < command.tickets.length; index += 1) {
        const ticket = command.tickets[index];
        if (
            ticket.clientId !== command.authority.clientId ||
            ticket.username !== command.authority.username
        ) {
            throw new AuthMutationRejectedError('Agent ticket authority differs', 403);
        }
        if (
            ticket.issuedAtEpochMs !== command.capturedAtEpochMs ||
            ticket.sessionExpiresAtEpochMs <= command.capturedAtEpochMs ||
            ticket.ticketExpiresAtEpochMs <= command.capturedAtEpochMs ||
            ticket.ticketExpiresAtEpochMs > ticket.sessionExpiresAtEpochMs
        ) {
            throw new AuthMutationRejectedError('Agent ticket lifecycle is invalid', 410);
        }
        if (
            seenAgentIds.has(ticket.agentId) ||
            seenSessionIds.has(ticket.sessionId) ||
            seenTicketDigests.has(ticket.ticketDigest)
        ) {
            throw new AuthMutationRejectedError(
                'Agent ticket batch identity is duplicated',
                409,
            );
        }
        seenAgentIds.add(ticket.agentId);
        seenSessionIds.add(ticket.sessionId);
        seenTicketDigests.add(ticket.ticketDigest);
        validateIssueSessionRead(computed.sessions[index]?.session, {
            kind: 'issue-session',
            ...read.sessions[index],
        });
        const current = read.tickets[index];
        if (current && !equalAuthJson(current.value, computed.agentTickets[index])) {
            throw new AuthMutationRejectedError('Agent ticket digest collision', 409);
        }
    }
}

export function validateConsumeAgentTicketRead(
    command: ConsumeAuthAgentTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>,
): void {
    const ticket = requireAuthTicket(read.ticket).value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        throw new AuthMutationRejectedError('Agent ticket is expired', 410);
    }
    if (
        !read.session || read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Agent ticket authority differs', 401);
    }
}
