import type {
    AuthMutationDomainComputed,
    AuthMutationRead,
    IssueAuthWsTicketCommand
} from '../auth-mutation-contracts.ts';
import { equalAuthJson } from '../validate/auth-mutation-validation.ts';

interface ComputeAuthTicketMutationInput {
    readonly kind: IssueAuthWsTicketCommand['kind'];
    readonly command: IssueAuthWsTicketCommand;
    readonly read: AuthMutationRead;
}

export function computeAuthTicketMutation(
    input: ComputeAuthTicketMutationInput
): AuthMutationDomainComputed {
    return computeIssueAuthWebSocketTicket(
        input.command,
        input.read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
    );
}

function computeIssueAuthWebSocketTicket(
    command: IssueAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
): AuthMutationDomainComputed {
    return {
        command,
        read,
        sessions: [],
        agentTickets: [],
        logoutOutbox: null,
        result: {
            requestId: command.requestId,
            kind: 'ws-ticket-issued',
            ticketDigest: command.ticketRecord.ticketDigest,
            sessionId: command.ticketRecord.sessionId,
            issuedAtEpochMs: command.ticketRecord.issuedAtEpochMs,
            expiresAtEpochMs: command.ticketRecord.expiresAtEpochMs
        },
        outcome: read.ticket && equalAuthJson(read.ticket.value, command.ticketRecord) ? 'replay' : 'write'
    };
}
