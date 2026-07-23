import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationRead,
    ConsumeAuthWsTicketCommand,
    IssueAuthSessionCommand,
    IssueAuthWsTicketCommand,
    LogoutAuthSessionCommand,
    RegisterAuthUserCommand,
} from './auth-state-contracts.ts';
import { AuthMutationRejectedError } from './auth-state-errors.ts';
import {
    validateAgentIssueRead,
    validateConsumeAgentTicketRead,
} from './auth-state-agent-validation.ts';
import {
    equalAuthJson,
    requireAuthTicket,
    requireMatchingAuthKind,
    validateIssueSessionRead,
} from './auth-state-validation-shared.ts';

export function validateAuthMutation(
    command: AuthMutationCommand,
    read: AuthMutationRead,
    computed: AuthMutationComputed,
): void {
    requireMatchingAuthKind(command, read);
    if (computed.command !== command || computed.read !== read) {
        throw new AuthMutationRejectedError('Auth computed input identity differs');
    }
    if (command.capturedAtEpochMs < 0) {
        throw new AuthMutationRejectedError('Auth command timestamp is invalid');
    }
    switch (command.kind) {
        case 'register-user':
            validateRegisterRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'register-user' }>,
            );
            return;
        case 'issue-session':
            validateIssueSessionRead(
                computed.sessions[0]?.session,
                read as Extract<AuthMutationRead, { kind: 'issue-session' }>,
            );
            validateIssueSessionUserAuthority(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-session' }>,
            );
            return;
        case 'logout-session':
            validateLogoutRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'logout-session' }>,
            );
            return;
        case 'issue-ws-ticket':
            validateIssueWsTicketRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>,
            );
            return;
        case 'consume-ws-ticket':
            validateConsumeWsTicketRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>,
            );
            return;
        case 'issue-agent-tickets':
            validateAgentIssueRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
                computed,
            );
            return;
        case 'consume-agent-ticket':
            validateConsumeAgentTicketRead(
                command,
                read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>,
            );
            return;
    }
}

function validateRegisterRead(
    command: RegisterAuthUserCommand,
    read: Extract<AuthMutationRead, { kind: 'register-user' }>,
): void {
    if (read.byUsername && !equalAuthJson(read.byUsername.value, command.user)) {
        throw new AuthMutationRejectedError('Auth username already exists', 409);
    }
    if (read.byClientId && !equalAuthJson(read.byClientId.value, command.user)) {
        throw new AuthMutationRejectedError('Auth client identity already exists', 409);
    }
    if ((read.byUsername === null) !== (read.byClientId === null)) {
        throw new AuthMutationRejectedError('Auth user indexes are inconsistent', 500);
    }
}

function validateIssueSessionUserAuthority(
    command: IssueAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-session' }>,
): void {
    if (
        command.session.clientId !== command.authority.clientId ||
        command.session.username.trim().toLowerCase() !==
            command.authority.normalizedUsername
    ) {
        throw new AuthMutationRejectedError('Auth session user authority differs', 403);
    }
    if (command.authority.kind === 'static-client') {
        if (read.userByUsername || read.userByClientId) {
            throw new AuthMutationRejectedError(
                'Static auth session authority conflicts with a registered user',
                403,
            );
        }
        return;
    }
    if (
        !read.userByUsername || !read.userByClientId ||
        read.userByUsername.entry.revision !== command.authority.userRevision ||
        read.userByClientId.entry.revision !== command.authority.userRevision ||
        !equalAuthJson(read.userByUsername.value, read.userByClientId.value)
    ) {
        throw new AuthMutationRejectedError(
            'Registered auth user authority is unavailable',
            403,
        );
    }
    const user = read.userByUsername.value;
    if (
        user.status !== 'active' ||
        user.clientId !== command.authority.clientId ||
        user.normalizedUsername !== command.authority.normalizedUsername ||
        user.clientId !== command.session.clientId ||
        user.username !== command.session.username
    ) {
        throw new AuthMutationRejectedError('Registered auth user authority differs', 403);
    }
}

function validateLogoutRead(
    command: LogoutAuthSessionCommand,
    read: Extract<AuthMutationRead, { kind: 'logout-session' }>,
): void {
    if (read.bySession === null && read.byToken === null) return;
    if (
        !read.bySession || !read.byToken ||
        !equalAuthJson(read.bySession.value, read.byToken.value)
    ) {
        throw new AuthMutationRejectedError('Auth logout indexes are inconsistent', 500);
    }
    const session = read.bySession.value;
    if (
        session.clientId !== command.expected.clientId ||
        session.username !== command.expected.username ||
        session.sessionId !== command.expected.sessionId ||
        session.issuedAtEpochMs !== command.expected.issuedAtEpochMs ||
        session.expiresAtEpochMs !== command.expected.expiresAtEpochMs
    ) {
        throw new AuthMutationRejectedError('Auth logout authority differs', 403);
    }
}

function validateIssueWsTicketRead(
    command: IssueAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>,
): void {
    if (
        !read.session ||
        read.session.value.clientId !== command.ticketRecord.clientId ||
        read.session.value.accessTokenDigest !== command.ticketRecord.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError(
            'Websocket ticket session authority differs',
            401,
        );
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

function validateConsumeWsTicketRead(
    command: ConsumeAuthWsTicketCommand,
    read: Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>,
): void {
    const ticket = requireAuthTicket(read.ticket).value;
    if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
        throw new AuthMutationRejectedError('Websocket ticket is expired', 410);
    }
    if (
        ticket.sessionId !== command.expectedSessionId ||
        !read.session || read.session.value.sessionId !== ticket.sessionId ||
        read.session.value.clientId !== ticket.clientId ||
        read.session.value.accessTokenDigest !== ticket.accessTokenDigest
    ) {
        throw new AuthMutationRejectedError('Websocket ticket authority differs', 401);
    }
}
