import type { AuthMutationCommand } from '../mutation/auth-mutation-contracts.ts';
import { AppInboxType } from '../../services/app-inbox-contracts.ts';

export const AUTH_STATE_APP_INBOX_TOPIC = 'app-inbox.auth-state';

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
      return toContextId([
        ['operation', command.kind],
        ['username', command.user.normalizedUsername],
      ]);
    case 'issue-session':
      return toContextId([
        ['operation', command.kind],
        ['username', command.authority.normalizedUsername],
      ]);
    case 'logout-session':
      return toSessionContextId(command.expected.clientId, command.expected.sessionId);
    case 'issue-ws-ticket':
      return toSessionContextId(
        command.ticketRecord.clientId,
        command.ticketRecord.sessionId,
      );
    case 'consume-ws-ticket':
      return toContextId([['credential', command.ticketDigest]]);
    case 'issue-agent-tickets':
      return toSessionContextId(command.authority.clientId, command.authority.sessionId);
    case 'consume-agent-ticket':
      return toContextId([['credential', command.ticketDigest]]);
  }
}

function toSessionContextId(clientId: string, sessionId: string): string {
  return toContextId([
    ['client', clientId],
    ['session', sessionId],
  ]);
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
