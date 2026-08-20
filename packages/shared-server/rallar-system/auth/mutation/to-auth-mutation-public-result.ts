import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import type {
  AuthMutationCommand,
  AuthMutationIntent,
  AuthMutationPublicResult,
  AuthMutationResult,
} from './auth-mutation-contracts.ts';

type AuthMutationPublicResultRequest = AuthMutationIntent | AuthMutationCommand;

export async function toAuthMutationPublicResult(
  request: AuthMutationPublicResultRequest,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  switch (request.kind) {
    case 'register-user':
      return toRegisteredUserPublicResult(result);
    case 'logout-session':
      return toLoggedOutPublicResult(result);
    case 'issue-session':
      return await toIssuedSessionPublicResult(request, result, credentialIssuer);
    case 'issue-ws-ticket':
      return await toIssuedWebSocketTicketPublicResult(request, result, credentialIssuer);
    case 'consume-ws-ticket':
    case 'consume-agent-ticket':
      return await toConsumedTicketPublicResult(request, result, credentialIssuer);
    case 'issue-agent-tickets':
      return await toIssuedAgentTicketsPublicResult(request, result, credentialIssuer);
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
  request: Extract<AuthMutationPublicResultRequest, { kind: 'issue-session' }>,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const receipt = requireResultKind(result, 'session-issued');
  const expected =
    'session' in request
      ? request.session
      : { clientId: request.clientId, username: request.username };
  if (
    receipt.clientId !== expected.clientId ||
    receipt.username !== expected.username ||
    ('sessionId' in expected && receipt.sessionId !== expected.sessionId)
  ) {
    throw new Error('Auth session result identity differs');
  }
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
  request: Extract<AuthMutationPublicResultRequest, { kind: 'issue-ws-ticket' }>,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const receipt = requireResultKind(result, 'ws-ticket-issued');
  const expectedSessionId =
    'authority' in request ? request.authority.sessionId : request.ticketRecord.sessionId;
  if (receipt.sessionId !== expectedSessionId) {
    throw new Error('Auth websocket ticket result identity differs');
  }
  const ticket = await credentialIssuer.issueWebSocketTicket(request.requestId, receipt.sessionId);
  await requireCredentialDigest(ticket, receipt.ticketDigest);
  return {
    ticket,
    sessionId: receipt.sessionId,
    expiresAtEpochMs: receipt.expiresAtEpochMs,
  };
}

async function toConsumedTicketPublicResult(
  request: Extract<
    AuthMutationPublicResultRequest,
    { kind: 'consume-ws-ticket' | 'consume-agent-ticket' }
  >,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const expectedKind =
    request.kind === 'consume-ws-ticket' ? 'ws-ticket-consumed' : 'agent-ticket-consumed';
  const receipt = requireResultKind(result, expectedKind);
  if (request.kind === 'consume-ws-ticket' && receipt.sessionId !== request.expectedSessionId) {
    throw new Error('Auth consumed websocket ticket result identity differs');
  }
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
  request: Extract<AuthMutationPublicResultRequest, { kind: 'issue-agent-tickets' }>,
  result: AuthMutationResult,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationPublicResult> {
  const receipt = requireResultKind(result, 'agent-tickets-issued');
  const expectedAgentIds =
    'agentIds' in request ? request.agentIds : request.tickets.map((ticket) => ticket.agentId);
  if (
    receipt.tickets.length !== expectedAgentIds.length ||
    receipt.tickets.some((ticket, index) => ticket.agentId !== expectedAgentIds[index])
  ) {
    throw new Error('Auth agent ticket result identity differs');
  }
  return {
    tickets: await Promise.all(
      receipt.tickets.map(async (ticket) => {
        const plaintext = await credentialIssuer.issueAgentTicket(
          request.requestId,
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
