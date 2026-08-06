import { describe, expect, it } from 'vitest';

import type {
  AuthMutationCommand,
  AuthMutationRead,
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';
import { validateAuthMutation } from '@shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts';

const user = {
  clientId: 'client-1',
  username: 'alice',
  normalizedUsername: 'alice',
  displayName: null,
  passwordHash: 'password-hash',
  passwordSalt: 'password-salt',
  passwordAlgorithm: 'pbkdf2-sha256',
  passwordIterations: 120_000,
  roles: ['member'],
  status: 'active',
  createdAtEpochMs: 1_000,
  updatedAtEpochMs: 1_000,
} as const;
const session = {
  clientId: 'client-1',
  username: 'alice',
  sessionId: 'session-1',
  accessTokenDigest: 'access-token-digest',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 2_000,
} as const;
const websocketTicket = {
  ticketDigest: 'websocket-ticket-digest',
  accessTokenDigest: session.accessTokenDigest,
  sessionId: session.sessionId,
  clientId: session.clientId,
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 1_500,
} as const;
const agentTicketCommand = {
  agentId: 'agent-1',
  sessionId: 'agent-session-1',
  accessTokenDigest: 'agent-access-token-digest',
  ticketDigest: 'agent-ticket-digest',
  clientId: session.clientId,
  username: session.username,
  issuedAtEpochMs: 1_000,
  sessionExpiresAtEpochMs: 2_000,
  ticketExpiresAtEpochMs: 1_500,
} as const;
const persistedAgentTicket = {
  ticketDigest: agentTicketCommand.ticketDigest,
  accessTokenDigest: agentTicketCommand.accessTokenDigest,
  sessionId: agentTicketCommand.sessionId,
  clientId: agentTicketCommand.clientId,
  agentId: agentTicketCommand.agentId,
  issuedAtEpochMs: agentTicketCommand.issuedAtEpochMs,
  expiresAtEpochMs: agentTicketCommand.ticketExpiresAtEpochMs,
} as const;
const agentSession = {
  ...session,
  sessionId: agentTicketCommand.sessionId,
  accessTokenDigest: agentTicketCommand.accessTokenDigest,
} as const;
const emptySessionEntries = {
  byToken: null,
  bySession: null,
  expiredByTokenEntry: null,
  expiredBySessionEntry: null,
} as const;

interface AuthMutationCase {
  readonly command: AuthMutationCommand;
  readonly read: AuthMutationRead;
}

describe('auth mutation validation', () => {
  it('accepts the computed decision for every command family', () => {
    for (const { command, read } of authMutationCases()) {
      const computed = computeAuth(command, read);

      expect(() => validateAuthMutation(command, read, computed), command.kind).not.toThrow();
      expect(computed.command).toBe(command);
      expect(computed.read).toBe(read);
    }
  });

  it.each(validationRejectionCases())(
    'preserves the $label rejection',
    ({ command, read, computed, message, status }) => {
      const rejection = captureRejection(() => validateAuthMutation(command, read, computed));

      expect(rejection).toBeInstanceOf(AuthMutationRejectedError);
      expect(rejection).toMatchObject({ message, status, code: 'auth-mutation-rejected' });
    },
  );
});

function authMutationCases(): readonly AuthMutationCase[] {
  return [...registrationAndSessionCases(), ...webSocketTicketCases(), ...agentTicketCases()];
}

function registrationAndSessionCases(): readonly AuthMutationCase[] {
  return [
    {
      command: {
        version: 1,
        kind: 'register-user',
        requestId: 'register-request',
        capturedAtEpochMs: 1_000,
        user,
      },
      read: { kind: 'register-user', byUsername: null, byClientId: null },
    },
    {
      command: {
        version: 1,
        kind: 'issue-session',
        requestId: 'session-request',
        capturedAtEpochMs: 1_000,
        authority: { kind: 'static-client', clientId: 'client-1', normalizedUsername: 'alice' },
        session,
      },
      read: {
        kind: 'issue-session',
        userByUsername: null,
        userByClientId: null,
        ...emptySessionEntries,
      },
    },
    {
      command: {
        version: 1,
        kind: 'logout-session',
        requestId: 'logout-request',
        capturedAtEpochMs: 1_000,
        expected: session,
      },
      read: { kind: 'logout-session', ...emptySessionEntries },
    },
  ];
}

function webSocketTicketCases(): readonly AuthMutationCase[] {
  return [
    {
      command: {
        version: 1,
        kind: 'issue-ws-ticket',
        requestId: 'websocket-issue-request',
        capturedAtEpochMs: 1_000,
        ticketRecord: websocketTicket,
      },
      read: {
        kind: 'issue-ws-ticket',
        ticket: null,
        expiredTicketEntry: null,
        session: entry(session, 'session=session-1'),
      },
    },
    {
      command: {
        version: 1,
        kind: 'consume-ws-ticket',
        requestId: 'websocket-consume-request',
        capturedAtEpochMs: 1_000,
        ticketDigest: websocketTicket.ticketDigest,
        expectedSessionId: session.sessionId,
      },
      read: {
        kind: 'consume-ws-ticket',
        ticket: entry(websocketTicket, 'ticket=websocket-ticket-digest'),
        session: entry(session, 'session=session-1'),
      },
    },
  ];
}

function agentTicketCases(): readonly AuthMutationCase[] {
  return [
    {
      command: {
        version: 1,
        kind: 'issue-agent-tickets',
        requestId: 'agent-issue-request',
        capturedAtEpochMs: 1_000,
        authority: session,
        tickets: [agentTicketCommand],
      },
      read: {
        kind: 'issue-agent-tickets',
        authority: matchingSessionEntries(session),
        sessions: [emptySessionEntries],
        tickets: [null],
        expiredTicketEntries: [null],
      },
    },
    {
      command: {
        version: 1,
        kind: 'consume-agent-ticket',
        requestId: 'agent-consume-request',
        capturedAtEpochMs: 1_000,
        ticketDigest: persistedAgentTicket.ticketDigest,
      },
      read: {
        kind: 'consume-agent-ticket',
        ticket: entry(persistedAgentTicket, 'ticket=agent-ticket-digest'),
        session: entry(agentSession, 'session=agent-session-1'),
      },
    },
  ];
}

function validationRejectionCases() {
  const cases = authMutationCases();
  return [
    ...registrationAndSessionRejectionCases(cases),
    ...webSocketTicketRejectionCases(cases),
    ...agentTicketRejectionCases(cases),
  ];
}

function registrationAndSessionRejectionCases(cases: readonly AuthMutationCase[]) {
  const registration = cases[0];
  const issueSession = cases[1];
  const logout = cases[2];
  const staticUserRead = {
    ...issueSession.read,
    userByUsername: entry(user, 'username=alice'),
    userByClientId: entry(user, 'client=client-1'),
  } as Extract<AuthMutationRead, { kind: 'issue-session' }>;

  return [
    rejectionCase(
      'registration username collision',
      registration.command,
      {
        ...registration.read,
        byUsername: entry({ ...user, clientId: 'different-client' }, 'username=alice'),
      },
      'Auth username already exists',
      409,
    ),
    rejectionCase(
      'static session authority conflict',
      issueSession.command,
      staticUserRead,
      'Static auth session authority conflicts with a registered user',
      403,
    ),
    rejectionCase(
      'logout index corruption',
      logout.command,
      { ...logout.read, bySession: entry(session, 'session=session-1') },
      'Auth logout indexes are inconsistent',
      500,
    ),
  ];
}

function webSocketTicketRejectionCases(cases: readonly AuthMutationCase[]) {
  const issueWebSocket = cases[3];
  const consumeWebSocket = cases[4];
  const expiredWebSocketCommand = {
    ...issueWebSocket.command,
    ticketRecord: { ...websocketTicket, expiresAtEpochMs: 1_000 },
  } as AuthMutationCommand;
  const missingWebSocketTicketRead = { ...consumeWebSocket.read, ticket: null } as AuthMutationRead;

  return [
    rejectionCase(
      'websocket ticket expiry',
      expiredWebSocketCommand,
      issueWebSocket.read,
      'Websocket ticket is expired',
      410,
    ),
    rejectionCase(
      'consumed websocket ticket absence',
      consumeWebSocket.command,
      missingWebSocketTicketRead,
      'Auth ticket is invalid or consumed',
      404,
      computeAuth(consumeWebSocket.command, consumeWebSocket.read),
    ),
  ];
}

function agentTicketRejectionCases(cases: readonly AuthMutationCase[]) {
  const issueAgent = cases[5];
  const consumeAgent = cases[6];
  const duplicateAgentCommand = {
    ...issueAgent.command,
    tickets: [agentTicketCommand, agentTicketCommand],
  } as AuthMutationCommand;
  const duplicateAgentRead = {
    ...issueAgent.read,
    sessions: [emptySessionEntries, emptySessionEntries],
    tickets: [null, null],
    expiredTicketEntries: [null, null],
  } as AuthMutationRead;
  const missingAgentTicketRead = { ...consumeAgent.read, ticket: null } as AuthMutationRead;

  return [
    rejectionCase(
      'agent ticket duplicate identity',
      duplicateAgentCommand,
      duplicateAgentRead,
      'Agent ticket batch identity is duplicated',
      409,
    ),
    rejectionCase(
      'consumed agent ticket absence',
      consumeAgent.command,
      missingAgentTicketRead,
      'Auth ticket is invalid or consumed',
      404,
      computeAuth(consumeAgent.command, consumeAgent.read),
    ),
  ];
}

function rejectionCase(
  label: string,
  command: AuthMutationCommand,
  read: AuthMutationRead,
  message: string,
  status: number,
  computed = computeAuth(command, read),
) {
  return {
    label,
    command,
    read,
    computed:
      computed.command === command && computed.read === read
        ? computed
        : { ...computed, command, read },
    message,
    status,
  };
}

function computeAuth(command: AuthMutationCommand, read: AuthMutationRead) {
  return computeAuthMutation({
    command,
    read,
    facts: { kind: command.kind },
    serviceId: 'auth-service',
  });
}

function captureRejection(callback: () => void): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected auth validation rejection');
}

function matchingSessionEntries(value: typeof session) {
  return {
    byToken: entry(value, 'token-digest=access-token-digest'),
    bySession: entry(value, 'session=session-1'),
    expiredByTokenEntry: null,
    expiredBySessionEntry: null,
  };
}

function entry<T>(value: T, key: string) {
  return {
    entry: {
      key,
      value: JSON.stringify(value),
      expireAtTimestamp: 2_000,
      updatedTimestamp: '1970-01-01T00:00:01.000Z',
      revision: 0,
    },
    value,
  };
}
