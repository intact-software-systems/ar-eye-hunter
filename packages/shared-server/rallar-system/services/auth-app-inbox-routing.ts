import { AppInboxType } from './app-inbox-contracts.ts';
import type { AuthMutationCommand } from './auth-state-contracts.ts';

export function toAuthAppInboxType(command: AuthMutationCommand): AppInboxType {
    switch (command.kind) {
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

export function toAuthCommandContextId(command: AuthMutationCommand): string {
    switch (command.kind) {
        case 'register-user':
            return command.user.normalizedUsername;
        case 'issue-session':
            return command.session.sessionId;
        case 'logout-session':
            return command.expected.sessionId;
        case 'issue-ws-ticket':
            return command.ticketRecord.sessionId;
        case 'consume-ws-ticket':
            return command.expectedSessionId;
        case 'issue-agent-tickets':
            return command.tickets.map((ticket) => ticket.sessionId).join(',');
        case 'consume-agent-ticket':
            return command.ticketDigest;
    }
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
