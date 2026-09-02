import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    IssueAuthWsTicketCommand
} from '../auth-mutation-contracts.ts';
import { equalAuthJson, requireAuthTicket } from '../validate/auth-mutation-validation.ts';
import { requireConsumedAuthSession, toConsumedAuthSessionResult } from './compute-auth-session-mutation.ts';
import { computeAuthWebSocketTicketWrite } from './compute-auth-ticket-write.ts';

type AuthTicketMutationCommand = Extract<AuthMutationCommand, { kind: 'issue-ws-ticket' | 'consume-ws-ticket'; }>;

interface ComputeAuthTicketMutationInput {
    readonly kind: AuthTicketMutationCommand['kind'];
    readonly command: AuthTicketMutationCommand;
    readonly read: AuthMutationRead;
}

export function computeAuthTicketMutation(
    input: ComputeAuthTicketMutationInput
): AuthMutationComputed {
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
                kind: 'consume-ws-ticket',
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
): AuthMutationComputed {
    return {
        kind: 'issue-ws-ticket',
        command,
        read,
        sessions: [],
        agentTickets: [],
        logoutDeletion: null,
        logoutOutbox: null,
        ticketDeletion: null,
        ticketWrites: [
            computeAuthWebSocketTicketWrite(
                command.ticketRecord,
                read.expiredTicketEntry?.revision ?? null
            )
        ],
        userRegistration: null,
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
