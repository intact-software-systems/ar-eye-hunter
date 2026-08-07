import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import type {
  AuthMutationCommand,
  AuthMutationPublicResult,
  AuthMutationResult,
} from './auth-mutation-contracts.ts';

export async function toAuthMutationPublicResult(
  command: AuthMutationCommand,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  switch (command.kind) {
    case 'register-user':
      return toRegisteredUserPublicResult(result);
    case 'logout-session':
      return toLoggedOutPublicResult(result);
    case 'issue-session':
      return await toIssuedSessionPublicResult(result, credentialIssuer);
    case 'issue-ws-ticket':
      return await toIssuedWebSocketTicketPublicResult(command, result, credentialIssuer);
    case 'consume-ws-ticket':
    case 'consume-agent-ticket':
      return await toConsumedTicketPublicResult(command, result, credentialIssuer);
    case 'issue-agent-tickets':
      return await toIssuedAgentTicketsPublicResult(command, result, credentialIssuer);
  }
}

function toRegisteredUserPublicResult(result: AuthMutationResult): AuthMutationPublicResult {
  if (!('registeredAtEpochMs' in result)) {
    throw new Error('Auth registration result kind differs');
  }
  return {
    clientId: result.clientId,
    username: result.username,
    displayName: result.displayName,
    registeredAtEpochMs: result.registeredAtEpochMs,
  };
}

function toLoggedOutPublicResult(result: AuthMutationResult): AuthMutationPublicResult {
  if (!('loggedOut' in result)) {
    throw new Error('Auth logout result kind differs');
  }
  return { loggedOut: result.loggedOut };
}

async function toIssuedSessionPublicResult(
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const receipt = requireResultKind(result, 'session-issued');
  const accessToken = await resolveAccessToken(
    credentialIssuer,
    receipt.sessionId,
    receipt.accessTokenDigest,
  );
  return {
    clientId: receipt.clientId,
    username: receipt.username,
    accessToken,
    sessionId: receipt.sessionId,
    expiresAtEpochMs: receipt.expiresAtEpochMs,
  };
}

async function toIssuedWebSocketTicketPublicResult(
  command: Extract<AuthMutationCommand, { kind: 'issue-ws-ticket' }>,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const receipt = requireResultKind(result, 'ws-ticket-issued');
  const ticket = await credentialIssuer.issueWebSocketTicket(command.requestId, receipt.sessionId);
  await requireCredentialDigest(ticket, receipt.ticketDigest);
  return {
    ticket,
    sessionId: receipt.sessionId,
    expiresAtEpochMs: receipt.expiresAtEpochMs,
  };
}

async function toConsumedTicketPublicResult(
  command: Extract<AuthMutationCommand, { kind: 'consume-ws-ticket' | 'consume-agent-ticket' }>,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const expectedKind =
    command.kind === 'consume-ws-ticket' ? 'ws-ticket-consumed' : 'agent-ticket-consumed';
  const receipt = requireResultKind(result, expectedKind);
  const accessToken = await resolveAccessToken(
    credentialIssuer,
    receipt.sessionId,
    receipt.accessTokenDigest,
  );
  return {
    clientId: receipt.clientId,
    username: receipt.username,
    accessToken,
    sessionId: receipt.sessionId,
    issuedAtEpochMs: receipt.issuedAtEpochMs,
    expiresAtEpochMs: receipt.expiresAtEpochMs,
  };
}

async function toIssuedAgentTicketsPublicResult(
  command: Extract<AuthMutationCommand, { kind: 'issue-agent-tickets' }>,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const receipt = requireResultKind(result, 'agent-tickets-issued');
  const bySession = new Map(command.tickets.map((ticket) => [ticket.sessionId, ticket]));
  return {
    tickets: await Promise.all(
      receipt.tickets.map(async (ticket) => {
        const identity = bySession.get(ticket.sessionId);
        if (!identity || identity.agentId !== ticket.agentId) {
          throw new Error('Auth agent ticket result identity differs');
        }
        const plaintext = await credentialIssuer.issueAgentTicket(
          command.requestId,
          ticket.agentId,
          ticket.sessionId,
        );
        await requireCredentialDigest(plaintext, ticket.ticketDigest);
        return {
          agentId: ticket.agentId,
          ticket: plaintext,
          sessionId: ticket.sessionId,
          expiresAtEpochMs: ticket.expiresAtEpochMs,
        };
      }),
    ),
  };
}

function requireResultKind<K extends Extract<AuthMutationResult, { kind: string }>['kind']>(
  result: AuthMutationResult,
  kind: K,
): Extract<AuthMutationResult, { kind: K }> {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('kind' in result) ||
    result.kind !== kind
  ) {
    throw new Error(`Auth AppInbox result kind differs: ${kind}`);
  }
  return result as Extract<AuthMutationResult, { kind: K }>;
}

async function resolveAccessToken(
  credentialIssuer: AuthCredentialIssuer,
  sessionId: string,
  expectedDigest: string,
): Promise<string> {
  const derived = await credentialIssuer.issueAccessToken(sessionId);
  await requireCredentialDigest(derived, expectedDigest);
  return derived;
}

async function requireCredentialDigest(plaintext: string, expectedDigest: string): Promise<void> {
  if ((await hashAuthSecret(plaintext)) !== expectedDigest) {
    throw new Error('Auth AppInbox result credential digest differs');
  }
}
