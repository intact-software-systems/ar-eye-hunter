import type {
    AuthMutationCommand,
    AuthMutationDomainComputed,
    AuthMutationRead,
    IssueAuthWsTicketCommand
} from '../auth-mutation-contracts.ts';
import { equalAuthJson, requireAuthTicket } from '../validate/auth-mutation-validation.ts';
import { requireConsumedAuthSession, toConsumedAuthSessionResult } from './compute-auth-session-mutation.ts';

type AuthTicketMutationCommand = Extract<AuthMutationCommand, { kind: 'issue-ws-ticket' | 'consume-ws-ticket'; }>;

interface ComputeAuthTicketMutationInput {
    readonly kind: AuthTicketMutationCommand['kind'];
    readonly command: AuthTicketMutationCommand;
    readonly read: AuthMutationRead;
}

export function computeAuthTicketMutation(
    input: ComputeAuthTicketMutationInput
): AuthMutationDomainComputed {
    switch (input.kind) {
        case 'issue-ws-ticket':
            return computeIssueAuthWebSocketTicket(
                input.command as IssueAuthWsTicketCommand,
                input.read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
            );
        case 'consume-ws-ticket': {
            const command = input.command as Extract<AuthMutationCommand, { kind: 'consume-ws-ticket'; }>;
            const consumeRead = input.read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket'; }>;
            const ticket = requireAuthTicket(consumeRead.ticket);
            const requestId = command.requestId;
            const session = requireConsumedAuthSession(
                consumeRead.session,
                'Websocket ticket session is unavailable'
            );
            const accessTokenDigest = ticket.value.accessTokenDigest;
            return {
                command,
                read: input.read,
                sessions: [],
                agentTickets: [],
                logoutOutbox: null,
                result: toConsumedAuthSessionResult({
                    kind: 'ws-ticket-consumed',
                    requestId,
                    session,
                    accessTokenDigest
                }),
                outcome: 'write'
            };
        }
    }
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
