import { validateRuntimeStateExpiredAuthority } from '../../../../runtime-state/RuntimeStateExpiredEntry.ts';
import { authTicketDigestKey } from '../../persistence/auth-storage-keys.ts';
import type {
    AuthMutationCommand,
    AuthMutationRead,
    ConsumeAuthWsTicketCommand,
    IssueAuthWsTicketCommand
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { equalAuthJson, requireAuthTicket } from './auth-mutation-validation.ts';

type AuthTicketMutationCommand = Extract<AuthMutationCommand, { kind: 'issue-ws-ticket' | 'consume-ws-ticket'; }>;

interface ValidateAuthTicketMutationInput {
    readonly kind: AuthTicketMutationCommand['kind'];
    readonly command: AuthTicketMutationCommand;
    readonly read: AuthMutationRead;
}

export function validateAuthTicketMutation(validation: ValidateAuthTicketMutationInput): void {
    switch (validation.kind) {
        case 'issue-ws-ticket':
            return validateIssueAuthWebSocketTicket(
                validation.command as IssueAuthWsTicketCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
            );
        case 'consume-ws-ticket':
            return validateConsumeAuthWebSocketTicket(
                validation.command as ConsumeAuthWsTicketCommand,
                validation.read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket'; }>
            );
    }
}

function validateIssueAuthWebSocketTicket(
    command: IssueAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
): void {
    validateRuntimeStateExpiredAuthority(
        read.ticket,
        read.expiredTicketEntry,
        authTicketDigestKey(command.ticketRecord.ticketDigest),
        'Websocket ticket read'
    );
    if (
        !read.session ||
        read.session.value.clientId !== command.ticketRecord.clientId ||
        read.session.value.accessTokenDigest !== command.ticketRecord.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Websocket ticket session authority differs', 401);
    }
    if (
        command.ticketRecord.issuedAtEpochMs !== command.capturedAtEpochMs ||
        command.ticketRecord.expiresAtEpochMs <= command.capturedAtEpochMs ||
        command.ticketRecord.expiresAtEpochMs > read.session.value.expiresAtEpochMs
    ) {
        throw new AuthMutationRejectedError('Websocket ticket is expired', 410);
    }
    if (read.ticket && !equalAuthJson(read.ticket.value, command.ticketRecord)) {
        throw new AuthMutationRejectedError('Websocket ticket digest collision', 409);
    }
}

function validateConsumeAuthWebSocketTicket(
    command: ConsumeAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-ws-ticket'; }>
): void {
    const ticket = requireAuthTicket(read.ticket).value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        throw new AuthMutationRejectedError('Websocket ticket is expired', 410);
    }
    if (
        ticket.sessionId !== command.expectedSessionId ||
        !read.session ||
        read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Websocket ticket authority differs', 401);
    }
}
