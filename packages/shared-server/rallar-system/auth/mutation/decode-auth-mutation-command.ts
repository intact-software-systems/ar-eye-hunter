import {
  decodePersistedAgentSessionTicket,
  decodePersistedAuthSession,
  decodePersistedWebSocketTicket,
} from '../../repositories/auth-persistence-contracts.ts';
import { requireIssueSessionLifecycle } from '../sessions/require-issue-session-lifecycle.ts';

import type { AuthMutationCommand } from './auth-mutation-contracts.ts';

type AuthMutationRecord = ReturnType<typeof requireRecord>;

export function decodeAuthMutationCommand(input: unknown): AuthMutationCommand {
  const command = requireRecord(input, 'Auth mutation command');
  if (command.version !== 1) throw new TypeError('Auth mutation command version is invalid');
  requireString(command.requestId, 'Auth mutation requestId');
  requireTimestamp(command.capturedAtEpochMs, 'Auth mutation capturedAtEpochMs');
  validateAuthMutationCommand(command);
  assertNoPlaintextAuthFields(command);
  return structuredClone(command) as AuthMutationCommand;
}

function validateAuthMutationCommand(command: AuthMutationRecord): void {
  switch (command.kind) {
    case 'register-user':
      validateRegisterAuthUserCommand(command);
      return;
    case 'issue-session':
      validateIssueAuthSessionCommand(command);
      return;
    case 'logout-session':
      validateLogoutAuthSessionCommand(command);
      return;
    case 'issue-ws-ticket':
      validateIssueAuthWebSocketTicketCommand(command);
      return;
    case 'consume-ws-ticket':
      validateConsumeAuthWebSocketTicketCommand(command);
      return;
    case 'issue-agent-tickets':
      validateIssueAuthAgentTicketsCommand(command);
      return;
    case 'consume-agent-ticket':
      validateConsumeAuthAgentTicketCommand(command);
      return;
    default:
      throw new TypeError('Auth mutation command kind is invalid');
  }
}

function validateRegisterAuthUserCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, ['version', 'kind', 'requestId', 'capturedAtEpochMs', 'user']);
  validateAuthUserContract(command.user);
}

function validateIssueAuthSessionCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, [
    'version',
    'kind',
    'requestId',
    'capturedAtEpochMs',
    'authority',
    'session',
  ]);
  validateSessionAuthority(command.authority);
  requireIssueSessionLifecycle(
    command.capturedAtEpochMs as number,
    decodePersistedAuthSession(command.session),
  );
}

function validateLogoutAuthSessionCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, ['version', 'kind', 'requestId', 'capturedAtEpochMs', 'expected']);
  decodePersistedAuthSession(command.expected);
}

function validateIssueAuthWebSocketTicketCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, ['version', 'kind', 'requestId', 'capturedAtEpochMs', 'ticketRecord']);
  decodePersistedWebSocketTicket(command.ticketRecord);
}

function validateConsumeAuthWebSocketTicketCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, [
    'version',
    'kind',
    'requestId',
    'capturedAtEpochMs',
    'ticketDigest',
    'expectedSessionId',
  ]);
  requireString(command.ticketDigest, 'Auth websocket ticket digest');
  requireString(command.expectedSessionId, 'Auth websocket expected sessionId');
}

function validateIssueAuthAgentTicketsCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, [
    'version',
    'kind',
    'requestId',
    'capturedAtEpochMs',
    'authority',
    'tickets',
  ]);
  decodePersistedAuthSession(command.authority);
  validateAgentTicketCommands(command.tickets);
}

function validateConsumeAuthAgentTicketCommand(command: AuthMutationRecord): void {
  requireExactKeys(command, ['version', 'kind', 'requestId', 'capturedAtEpochMs', 'ticketDigest']);
  requireString(command.ticketDigest, 'Auth agent ticket digest');
}

function validateSessionAuthority(input: unknown): void {
  const authority = requireRecord(input, 'Auth session authority');
  requireString(authority.clientId, 'Auth session authority clientId');
  requireString(authority.normalizedUsername, 'Auth session authority normalizedUsername');
  if (authority.kind === 'registered-user') {
    requireExactKeys(authority, ['kind', 'clientId', 'normalizedUsername', 'userRevision']);
    requireTimestamp(authority.userRevision, 'Auth session authority userRevision');
  } else if (authority.kind === 'static-client') {
    requireExactKeys(authority, ['kind', 'clientId', 'normalizedUsername']);
  } else {
    throw new TypeError('Auth session authority kind is invalid');
  }
}

function validateAgentTicketCommands(input: unknown): void {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('Auth agent tickets must be a non-empty array');
  }
  for (const inputTicket of input) {
    validateAgentTicketCommand(requireRecord(inputTicket, 'Auth agent ticket command'));
  }
}

function validateAgentTicketCommand(ticket: AuthMutationRecord): void {
  requireExactKeys(ticket, [
    'agentId',
    'sessionId',
    'accessTokenDigest',
    'ticketDigest',
    'clientId',
    'username',
    'issuedAtEpochMs',
    'sessionExpiresAtEpochMs',
    'ticketExpiresAtEpochMs',
  ]);
  validateAgentTicketCommandFields(ticket);
}

function validateAgentTicketCommandFields(ticket: AuthMutationRecord): void {
  for (const field of [
    'agentId',
    'sessionId',
    'accessTokenDigest',
    'ticketDigest',
    'clientId',
    'username',
  ] as const) {
    requireString(ticket[field], `Auth agent ticket ${field}`);
  }
  for (const field of [
    'issuedAtEpochMs',
    'sessionExpiresAtEpochMs',
    'ticketExpiresAtEpochMs',
  ] as const) {
    requireTimestamp(ticket[field], `Auth agent ticket ${field}`);
  }
  validateAgentTicketCommandLifecycle(ticket);
}

function validateAgentTicketCommandLifecycle(ticket: AuthMutationRecord): void {
  const issuedAtEpochMs = ticket.issuedAtEpochMs as number;
  const sessionExpiresAtEpochMs = ticket.sessionExpiresAtEpochMs as number;
  decodePersistedAgentSessionTicket({
    ticketDigest: ticket.ticketDigest,
    accessTokenDigest: ticket.accessTokenDigest,
    sessionId: ticket.sessionId,
    clientId: ticket.clientId,
    agentId: ticket.agentId,
    issuedAtEpochMs: ticket.issuedAtEpochMs,
    expiresAtEpochMs: ticket.ticketExpiresAtEpochMs,
  });
  if (issuedAtEpochMs >= sessionExpiresAtEpochMs) {
    throw new TypeError('Auth agent session lifecycle is invalid');
  }
}

function validateAuthUserContract(input: unknown): void {
  const user = requireRecord(input, 'Auth user');
  requireExactKeys(user, [
    'clientId',
    'username',
    'normalizedUsername',
    'displayName',
    'passwordHash',
    'passwordSalt',
    'passwordAlgorithm',
    'passwordIterations',
    'roles',
    'status',
    'createdAtEpochMs',
    'updatedAtEpochMs',
  ]);
  validateAuthUserFields(user);
}

function validateAuthUserFields(user: AuthMutationRecord): void {
  for (const field of [
    'clientId',
    'username',
    'normalizedUsername',
    'passwordHash',
    'passwordSalt',
  ] as const) {
    requireString(user[field], `Auth user ${field}`);
  }
  if (user.displayName !== null) requireString(user.displayName, 'Auth user displayName');
  if (user.passwordAlgorithm !== 'pbkdf2-sha256') {
    throw new TypeError('Auth user passwordAlgorithm is invalid');
  }
  validateAuthUserMetadata(user);
}

function validateAuthUserMetadata(user: AuthMutationRecord): void {
  requireTimestamp(user.passwordIterations, 'Auth user passwordIterations');
  requireTimestamp(user.createdAtEpochMs, 'Auth user createdAtEpochMs');
  requireTimestamp(user.updatedAtEpochMs, 'Auth user updatedAtEpochMs');
  if (
    !Array.isArray(user.roles) ||
    user.roles.some((role) => typeof role !== 'string' || role.length === 0)
  )
    throw new TypeError('Auth user roles are invalid');
  if (user.status !== 'active' && user.status !== 'disabled') {
    throw new TypeError('Auth user status is invalid');
  }
}

function assertNoPlaintextAuthFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPlaintextAuthFields(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'password' || key === 'accessToken' || key === 'ticket') {
      throw new TypeError(`Auth mutation command contains forbidden plaintext field: ${key}`);
    }
    assertNoPlaintextAuthFields(nested);
  }
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(value: AuthMutationRecord, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`Auth mutation fields are invalid: ${actual.join(',')}`);
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
}
