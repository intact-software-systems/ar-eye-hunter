import { describe, expect, it } from 'vitest';

import type {
  AuthMutationCommand,
  AuthMutationRead,
} from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { computeAuthMutation } from '@shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts';

describe('auth mutation compute router evaluation order', () => {
  it('preserves predecessor command, read, and facts discriminant reads', () => {
    for (const fixture of kindReadFixtures()) {
      const counts = { command: 0, read: 0, facts: 0 };
      const command = trackKind(fixture.command, counts, 'command');
      const read = trackKind(fixture.read, counts, 'read');
      const facts = trackKind({ kind: fixture.command.kind }, counts, 'facts');

      computeAuthMutation({ command, read, facts, serviceId: 'auth-service' });

      expect(counts, fixture.command.kind).toEqual({
        command: 3,
        read: fixture.expectedReadKindCount,
        facts: 1,
      });
    }
  });
});

function trackKind<T extends Readonly<{ kind: string }>>(
  value: T,
  counts: Record<'command' | 'read' | 'facts', number>,
  count: 'command' | 'read' | 'facts',
): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (property === 'kind') counts[count] += 1;
      return Reflect.get(target, property, receiver);
    },
  });
}

function kindReadFixtures(): readonly Readonly<{
  command: AuthMutationCommand;
  read: AuthMutationRead;
  expectedReadKindCount: number;
}>[] {
  return [...registrationKindFixtures(), ...mutationFamilyKindFixtures()];
}

function registrationKindFixtures(): readonly Readonly<{
  command: AuthMutationCommand;
  read: AuthMutationRead;
  expectedReadKindCount: number;
}>[] {
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
      expectedReadKindCount: 2,
    },
  ];
}

function mutationFamilyKindFixtures(): readonly Readonly<{
  command: AuthMutationCommand;
  read: AuthMutationRead;
  expectedReadKindCount: number;
}>[] {
  return [
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
      expectedReadKindCount: 2,
    },
    {
      command: {
        version: 1,
        kind: 'issue-ws-ticket',
        requestId: 'websocket-request',
        capturedAtEpochMs: 1_001,
        ticketRecord: websocketTicket,
      },
      read: {
        kind: 'issue-ws-ticket',
        ticket: null,
        expiredTicketEntry: null,
        session: null,
      },
      expectedReadKindCount: 1,
    },
    {
      command: {
        version: 1,
        kind: 'issue-agent-tickets',
        requestId: 'agent-request',
        capturedAtEpochMs: 1_001,
        authority: session,
        tickets: [agentTicketCommand],
      },
      read: {
        kind: 'issue-agent-tickets',
        authority: emptySessionEntries,
        sessions: [emptySessionEntries],
        tickets: [null],
        expiredTicketEntries: [null],
      },
      expectedReadKindCount: 1,
    },
  ];
}

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
  issuedAtEpochMs: 1_001,
  expiresAtEpochMs: 1_500,
} as const;
const agentTicketCommand = {
  agentId: 'agent-1',
  sessionId: 'agent-session-1',
  accessTokenDigest: 'agent-access-token-digest',
  ticketDigest: 'agent-ticket-digest',
  clientId: session.clientId,
  username: session.username,
  issuedAtEpochMs: 1_001,
  sessionExpiresAtEpochMs: 2_000,
  ticketExpiresAtEpochMs: 1_500,
} as const;
const emptySessionEntries = {
  byToken: null,
  bySession: null,
  expiredByTokenEntry: null,
  expiredBySessionEntry: null,
} as const;
