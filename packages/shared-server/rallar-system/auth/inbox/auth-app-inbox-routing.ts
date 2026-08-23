import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import type { AuthMutationCommand, AuthMutationIntent } from '../mutation/auth-mutation-contracts.ts';

export const AUTH_STATE_APP_INBOX_TOPIC = 'app-inbox.auth-state';

export function toAuthAppInboxType(
    mutation: Readonly<{ kind: AuthMutationCommand['kind']; }>
): AppInboxType {
    switch (mutation.kind) {
        case 'register-user':
            return AppInboxType.AUTH_USER_REGISTER;
        case 'issue-session':
            return AppInboxType.AUTH_SESSION_ISSUE;
        case 'logout-session':
            return AppInboxType.AUTH_SESSION_LOGOUT;
        case 'issue-ws-ticket':
            return AppInboxType.AUTH_WS_TICKET_ISSUE;
        case 'consume-ws-ticket':
            return AppInboxType.AUTH_WS_TICKET_CONSUME;
        case 'issue-agent-tickets':
            return AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE;
        case 'consume-agent-ticket':
            return AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME;
    }
}

export function toAuthIntentContextId(intent: AuthMutationIntent): string {
    switch (intent.kind) {
        case 'register-user':
            return toAuthUsernameContextId(intent.kind, intent.registration.normalizedUsername);
        case 'issue-session':
            return toAuthUsernameContextId(intent.kind, intent.authority.normalizedUsername);
        case 'logout-session':
            return toAuthSessionContextId(intent.expected.clientId, intent.expected.sessionId);
        case 'issue-ws-ticket':
        case 'issue-agent-tickets':
            return toAuthSessionContextId(intent.authority.clientId, intent.authority.sessionId);
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            return toAuthCredentialContextId(intent.ticketDigest);
    }
}

export function toAuthIntentSenderId(intent: AuthMutationIntent): string {
    switch (intent.kind) {
        case 'register-user':
            return intent.registration.normalizedUsername;
        case 'issue-session':
            return intent.clientId;
        case 'logout-session':
            return intent.expected.clientId;
        case 'issue-ws-ticket':
        case 'issue-agent-tickets':
            return intent.authority.clientId;
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            return intent.ticketDigest;
    }
}

export function toAuthCommandContextId(command: AuthMutationCommand): string {
    switch (command.kind) {
        case 'register-user':
            return toAuthUsernameContextId(command.kind, command.user.normalizedUsername);
        case 'issue-session':
            return toAuthUsernameContextId(command.kind, command.authority.normalizedUsername);
        case 'logout-session':
            return toAuthSessionContextId(command.expected.clientId, command.expected.sessionId);
        case 'issue-ws-ticket':
            return toAuthSessionContextId(
                command.ticketRecord.clientId,
                command.ticketRecord.sessionId
            );
        case 'consume-ws-ticket':
            return toAuthCredentialContextId(command.ticketDigest);
        case 'issue-agent-tickets':
            return toAuthSessionContextId(command.authority.clientId, command.authority.sessionId);
        case 'consume-agent-ticket':
            return toAuthCredentialContextId(command.ticketDigest);
    }
}

export function toAuthUsernameContextId(
    operation: 'register-user' | 'issue-session',
    normalizedUsername: string
): string {
    return toContextId([
        ['operation', operation],
        ['username', normalizedUsername]
    ]);
}

export function toAuthSessionContextId(clientId: string, sessionId: string): string {
    return toContextId([
        ['client', clientId],
        ['session', sessionId]
    ]);
}

export function toAuthCredentialContextId(credentialDigest: string): string {
    return toContextId([['credential', credentialDigest]]);
}

function toContextId(parts: readonly (readonly [string, string])[]): string {
    return parts.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join(':');
}

export function toAuthCommandSenderId(command: AuthMutationCommand): string {
    switch (command.kind) {
        case 'register-user':
            return command.user.clientId;
        case 'issue-session':
            return command.session.clientId;
        case 'logout-session':
            return command.expected.clientId;
        case 'issue-ws-ticket':
            return command.ticketRecord.clientId;
        case 'issue-agent-tickets':
            return command.authority.clientId;
        case 'consume-ws-ticket':
        case 'consume-agent-ticket':
            return command.ticketDigest;
    }
}
