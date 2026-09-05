import type {
    AuthMutationCommand,
    AuthMutationRead,
    ConsumeAuthWsTicketCommand,
    IssueAuthWsTicketCommand
} from '../auth-mutation-contracts.ts';
import {
    equalAuthJson,
    toAuthMutationValidationIssue,
    type AuthMutationValidationIssue
} from './auth-mutation-validation.ts';

type AuthTicketMutationCommand = Extract<AuthMutationCommand, { kind: 'issue-ws-ticket' | 'consume-ws-ticket'; }>;

interface ValidateAuthTicketMutationInput {
    readonly kind: AuthTicketMutationCommand['kind'];
    readonly command: AuthTicketMutationCommand;
    readonly read: AuthMutationRead;
}

export function validateAuthTicketMutation(
    validation: ValidateAuthTicketMutationInput
): readonly AuthMutationValidationIssue[] {
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

function validateConsumeAuthWebSocketTicket(
    command: ConsumeAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-ws-ticket'; }>
): readonly AuthMutationValidationIssue[] {
    if (read.ticket === null) {
        return [toAuthMutationValidationIssue('read.ticket', 'Auth ticket is invalid or consumed', 404)];
    }
    const issues: AuthMutationValidationIssue[] = [];
    const ticket = read.ticket.value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        issues.push(toAuthMutationValidationIssue('read.ticket', 'Websocket ticket is expired', 410));
    }
    if (
        ticket.sessionId !== command.expectedSessionId ||
        !read.session ||
        read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        issues.push(toAuthMutationValidationIssue('read.session', 'Websocket ticket authority differs', 401));
    }
    return issues;
}
