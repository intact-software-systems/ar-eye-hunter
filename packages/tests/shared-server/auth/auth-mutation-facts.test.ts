import { describe, expect, it } from 'vitest';

import type { AuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { AuthMutationCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { captureAuthMutationFacts } from '@shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts';

interface AuthFactsDigests {
  readonly accessToken: string;
  readonly websocketTicket: string;
  readonly firstAgentAccess: string;
  readonly firstAgentTicket: string;
  readonly secondAgentAccess: string;
  readonly secondAgentTicket: string;
}

interface AgentTicketFixtureInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly accessTokenDigest: string;
  readonly ticketDigest: string;
}

const session = {
  clientId: 'client-1',
  username: 'alice',
  sessionId: 'session-1',
  accessTokenDigest: '',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 2_000,
} as const;
const authUser = {
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

describe('auth mutation facts', () => {
  it('captures all seven command kinds and preserves credential derivation order', async () => {
    const calls: string[] = [];
    const credentialIssuer = recordingCredentialIssuer(calls);
    const commands = await authMutationCommands();
    const expectedCalls = [
      [],
      ['access:session-1'],
      [],
      ['websocket:ws-request:session-1'],
      [],
      [
        'access:agent-session-1',
        'agent:agent-request:agent-1:agent-session-1',
        'access:agent-session-2',
        'agent:agent-request:agent-2:agent-session-2',
      ],
      [],
    ];

    for (let index = 0; index < commands.length; index += 1) {
      calls.length = 0;
      const command = commands[index];
      const facts = await captureAuthMutationFacts(command, credentialIssuer);

      expect(facts).toEqual({ kind: command.kind });
      expect(Object.keys(facts)).toEqual(['kind']);
      expect(calls).toEqual(expectedCalls[index]);
    }
  });

  it.each([
    ['issue-session', 'Auth session credential digest differs'],
    ['issue-ws-ticket', 'Websocket ticket digest differs'],
    ['issue-agent-tickets', 'Agent credential digest differs'],
  ] as const)('rejects a %s credential whose derived digest differs', async (kind, message) => {
    const command = (await authMutationCommands()).find((candidate) => candidate.kind === kind);
    if (!command) throw new Error(`Missing auth facts fixture: ${kind}`);

    const rejection = await captureAuthMutationFacts(
      withFirstCredentialDigest(command, 'mismatched-digest'),
      recordingCredentialIssuer([]),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AuthMutationRejectedError);
    expect(rejection).toMatchObject({ message, code: 'auth-mutation-rejected', status: 409 });
  });
});

function recordingCredentialIssuer(calls: string[]): AuthCredentialIssuer {
  return {
    issueAccessToken: async (sessionId) => {
      calls.push(`access:${sessionId}`);
      return `access-token:${sessionId}`;
    },
    issueWebSocketTicket: async (requestId, sessionId) => {
      calls.push(`websocket:${requestId}:${sessionId}`);
      return `websocket-ticket:${requestId}:${sessionId}`;
    },
    issueAgentTicket: async (requestId, agentId, sessionId) => {
      calls.push(`agent:${requestId}:${agentId}:${sessionId}`);
      return `agent-ticket:${requestId}:${agentId}:${sessionId}`;
    },
  };
}

async function authMutationCommands(): Promise<readonly AuthMutationCommand[]> {
  const digests = await readAuthFactsDigests();
  return [
    ...registrationAndSessionCommands(digests.accessToken),
    ...webSocketCommands(digests),
    ...agentCommands(digests),
  ];
}

async function readAuthFactsDigests(): Promise<AuthFactsDigests> {
  const [
    accessToken,
    websocketTicket,
    firstAgentAccess,
    firstAgentTicket,
    secondAgentAccess,
    secondAgentTicket,
  ] = await Promise.all([
    hashAuthSecret('access-token:session-1'),
    hashAuthSecret('websocket-ticket:ws-request:session-1'),
    hashAuthSecret('access-token:agent-session-1'),
    hashAuthSecret('agent-ticket:agent-request:agent-1:agent-session-1'),
    hashAuthSecret('access-token:agent-session-2'),
    hashAuthSecret('agent-ticket:agent-request:agent-2:agent-session-2'),
  ]);
  return {
    accessToken,
    websocketTicket,
    firstAgentAccess,
    firstAgentTicket,
    secondAgentAccess,
    secondAgentTicket,
  };
}

function registrationAndSessionCommands(accessTokenDigest: string): readonly AuthMutationCommand[] {
  return [
    {
      version: 1,
      kind: 'register-user',
      requestId: 'register-request',
      capturedAtEpochMs: 1_000,
      user: authUser,
    },
    {
      version: 1,
      kind: 'issue-session',
      requestId: 'session-request',
      capturedAtEpochMs: 1_000,
      authority: { kind: 'static-client', clientId: 'client-1', normalizedUsername: 'alice' },
      session: { ...session, accessTokenDigest },
    },
    {
      version: 1,
      kind: 'logout-session',
      requestId: 'logout-request',
      capturedAtEpochMs: 1_000,
      expected: { ...session, accessTokenDigest },
    },
  ];
}

function webSocketCommands(digests: AuthFactsDigests): readonly AuthMutationCommand[] {
  return [
    {
      version: 1,
      kind: 'issue-ws-ticket',
      requestId: 'ws-request',
      capturedAtEpochMs: 1_000,
      ticketRecord: {
        ticketDigest: digests.websocketTicket,
        accessTokenDigest: digests.accessToken,
        sessionId: 'session-1',
        clientId: 'client-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 1_500,
      },
    },
    {
      version: 1,
      kind: 'consume-ws-ticket',
      requestId: 'consume-ws-request',
      capturedAtEpochMs: 1_000,
      ticketDigest: digests.websocketTicket,
      expectedSessionId: 'session-1',
    },
  ];
}

function agentCommands(digests: AuthFactsDigests): readonly AuthMutationCommand[] {
  return [
    {
      version: 1,
      kind: 'issue-agent-tickets',
      requestId: 'agent-request',
      capturedAtEpochMs: 1_000,
      authority: { ...session, accessTokenDigest: digests.accessToken },
      tickets: [
        agentTicket({
          agentId: 'agent-1',
          sessionId: 'agent-session-1',
          accessTokenDigest: digests.firstAgentAccess,
          ticketDigest: digests.firstAgentTicket,
        }),
        agentTicket({
          agentId: 'agent-2',
          sessionId: 'agent-session-2',
          accessTokenDigest: digests.secondAgentAccess,
          ticketDigest: digests.secondAgentTicket,
        }),
      ],
    },
    {
      version: 1,
      kind: 'consume-agent-ticket',
      requestId: 'consume-agent-request',
      capturedAtEpochMs: 1_000,
      ticketDigest: digests.firstAgentTicket,
    },
  ];
}

function agentTicket(input: AgentTicketFixtureInput) {
  return {
    agentId: input.agentId,
    sessionId: input.sessionId,
    accessTokenDigest: input.accessTokenDigest,
    ticketDigest: input.ticketDigest,
    clientId: 'client-1',
    username: 'alice',
    issuedAtEpochMs: 1_000,
    sessionExpiresAtEpochMs: 2_000,
    ticketExpiresAtEpochMs: 1_500,
  };
}

function withFirstCredentialDigest(
  command: AuthMutationCommand,
  digest: string,
): AuthMutationCommand {
  switch (command.kind) {
    case 'issue-session':
      return { ...command, session: { ...command.session, accessTokenDigest: digest } };
    case 'issue-ws-ticket':
      return { ...command, ticketRecord: { ...command.ticketRecord, ticketDigest: digest } };
    case 'issue-agent-tickets':
      return {
        ...command,
        tickets: [
          { ...command.tickets[0], accessTokenDigest: digest },
          ...command.tickets.slice(1),
        ],
      };
    default:
      return command;
  }
}
