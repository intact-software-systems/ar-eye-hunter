import type { AuthCredentialIssuer } from '../credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import { materializeAuthUserRegistration } from '../login/prepare-auth-user-registration.ts';
import type {
  AuthMutationCommand,
  AuthMutationFacts,
  AuthMutationIntent,
} from './auth-mutation-contracts.ts';
import { deriveAuthMutationId } from './derive-auth-mutation-id.ts';

export interface AuthMutationMaterialization {
  readonly command: AuthMutationCommand;
  readonly facts: AuthMutationFacts;
}

export async function materializeAuthMutationIntent(
  intent: AuthMutationIntent,
  dependencies: Readonly<{
    credentialIssuer: AuthCredentialIssuer;
    nowEpochMs: () => number;
  }>,
): Promise<AuthMutationMaterialization> {
  const capturedAtEpochMs = dependencies.nowEpochMs();
  const command = await materializeAuthMutationCommand(
    intent,
    capturedAtEpochMs,
    dependencies.credentialIssuer,
  );
  return { command, facts: { kind: command.kind } };
}

async function materializeAuthMutationCommand(
  intent: AuthMutationIntent,
  capturedAtEpochMs: number,
  credentialIssuer: AuthCredentialIssuer,
): Promise<AuthMutationCommand> {
  switch (intent.kind) {
    case 'register-user':
      return {
        version: 1,
        kind: intent.kind,
        requestId: intent.requestId,
        capturedAtEpochMs,
        user: materializeAuthUserRegistration(intent.registration, {
          clientId: await deriveAuthMutationId('user', [
            intent.requestId,
            intent.registration.normalizedUsername,
          ]),
          capturedAtEpochMs,
        }),
      };
    case 'issue-session':
      return await materializeSessionCommand(intent, capturedAtEpochMs, credentialIssuer);
    case 'logout-session':
      return {
        version: 1,
        kind: intent.kind,
        requestId: intent.requestId,
        capturedAtEpochMs,
        expected: intent.expected,
      };
    case 'issue-ws-ticket':
      return await materializeWebSocketTicketCommand(intent, capturedAtEpochMs, credentialIssuer);
    case 'consume-ws-ticket':
      return {
        version: 1,
        kind: intent.kind,
        requestId: intent.requestId,
        capturedAtEpochMs,
        ticketDigest: intent.ticketDigest,
        expectedSessionId: intent.expectedSessionId,
      };
    case 'issue-agent-tickets':
      return await materializeAgentTicketCommand(intent, capturedAtEpochMs, credentialIssuer);
    case 'consume-agent-ticket':
      return {
        version: 1,
        kind: intent.kind,
        requestId: intent.requestId,
        capturedAtEpochMs,
        ticketDigest: intent.ticketDigest,
      };
  }
}

async function materializeSessionCommand(
  intent: Extract<AuthMutationIntent, { kind: 'issue-session' }>,
  capturedAtEpochMs: number,
  credentialIssuer: AuthCredentialIssuer,
): Promise<Extract<AuthMutationCommand, { kind: 'issue-session' }>> {
  const sessionId = await deriveAuthMutationId('session', [
    intent.requestId,
    intent.authority.normalizedUsername,
    intent.clientId,
  ]);
  const accessToken = await credentialIssuer.issueAccessToken(sessionId);
  return {
    version: 1,
    kind: intent.kind,
    requestId: intent.requestId,
    capturedAtEpochMs,
    authority: intent.authority,
    session: {
      clientId: intent.clientId,
      username: intent.username,
      sessionId,
      accessTokenDigest: await hashAuthSecret(accessToken),
      issuedAtEpochMs: capturedAtEpochMs,
      expiresAtEpochMs: capturedAtEpochMs + intent.ttlMs,
    },
  };
}

async function materializeWebSocketTicketCommand(
  intent: Extract<AuthMutationIntent, { kind: 'issue-ws-ticket' }>,
  capturedAtEpochMs: number,
  credentialIssuer: AuthCredentialIssuer,
): Promise<Extract<AuthMutationCommand, { kind: 'issue-ws-ticket' }>> {
  const ticket = await credentialIssuer.issueWebSocketTicket(
    intent.requestId,
    intent.authority.sessionId,
  );
  return {
    version: 1,
    kind: intent.kind,
    requestId: intent.requestId,
    capturedAtEpochMs,
    ticketRecord: {
      ticketDigest: await hashAuthSecret(ticket),
      accessTokenDigest: intent.authority.accessTokenDigest,
      sessionId: intent.authority.sessionId,
      clientId: intent.authority.clientId,
      issuedAtEpochMs: capturedAtEpochMs,
      expiresAtEpochMs: capturedAtEpochMs + intent.ttlMs,
    },
  };
}

async function materializeAgentTicketCommand(
  intent: Extract<AuthMutationIntent, { kind: 'issue-agent-tickets' }>,
  capturedAtEpochMs: number,
  credentialIssuer: AuthCredentialIssuer,
): Promise<Extract<AuthMutationCommand, { kind: 'issue-agent-tickets' }>> {
  const tickets = [];
  for (const agentId of intent.agentIds) {
    const sessionId = await deriveAuthMutationId('agent-session', [
      intent.requestId,
      intent.authority.clientId,
      agentId,
    ]);
    const accessToken = await credentialIssuer.issueAccessToken(sessionId);
    const ticket = await credentialIssuer.issueAgentTicket(intent.requestId, agentId, sessionId);
    tickets.push({
      agentId,
      sessionId,
      accessTokenDigest: await hashAuthSecret(accessToken),
      ticketDigest: await hashAuthSecret(ticket),
      clientId: intent.authority.clientId,
      username: intent.authority.username,
      issuedAtEpochMs: capturedAtEpochMs,
      sessionExpiresAtEpochMs: intent.authority.expiresAtEpochMs,
      ticketExpiresAtEpochMs: Math.min(
        intent.authority.expiresAtEpochMs,
        capturedAtEpochMs + intent.ticketTtlMs,
      ),
    });
  }
  return {
    version: 1,
    kind: intent.kind,
    requestId: intent.requestId,
    capturedAtEpochMs,
    authority: intent.authority,
    tickets,
  };
}
