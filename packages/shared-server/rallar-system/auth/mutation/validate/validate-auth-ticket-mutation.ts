import type { AuthMutationRead, IssueAuthWsTicketCommand } from '../auth-mutation-contracts.ts';
import {
    equalAuthJson,
    toAuthMutationValidationIssue,
    type AuthMutationValidationIssue
} from './auth-mutation-validation.ts';

interface ValidateAuthTicketMutationInput {
    readonly kind: IssueAuthWsTicketCommand['kind'];
    readonly command: IssueAuthWsTicketCommand;
    readonly read: AuthMutationRead;
}

export function validateAuthTicketMutation(
    validation: ValidateAuthTicketMutationInput
): readonly AuthMutationValidationIssue[] {
    return validateIssueAuthWebSocketTicket(
        validation.command,
        validation.read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
    );
}

function validateIssueAuthWebSocketTicket(
    command: IssueAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-ws-ticket'; }>
): readonly AuthMutationValidationIssue[] {
    const issues: AuthMutationValidationIssue[] = [];
    if (
        !read.session ||
        read.session.value.clientId !== command.ticketRecord.clientId ||
        read.session.value.accessTokenDigest !== command.ticketRecord.accessTokenDigest
    ) {
        issues.push(
            toAuthMutationValidationIssue('read.session', 'Websocket ticket session authority differs', 401)
        );
    }
    if (
        command.ticketRecord.issuedAtEpochMs !== command.capturedAtEpochMs ||
        command.ticketRecord.expiresAtEpochMs <= command.capturedAtEpochMs ||
        (
            read.session !== null &&
            command.ticketRecord.expiresAtEpochMs > read.session.value.expiresAtEpochMs
        )
    ) {
        issues.push(toAuthMutationValidationIssue('command.ticketRecord', 'Websocket ticket is expired', 410));
    }
    if (read.ticket && !equalAuthJson(read.ticket.value, command.ticketRecord)) {
        issues.push(toAuthMutationValidationIssue('read.ticket', 'Websocket ticket digest collision', 409));
    }
    return issues;
}
