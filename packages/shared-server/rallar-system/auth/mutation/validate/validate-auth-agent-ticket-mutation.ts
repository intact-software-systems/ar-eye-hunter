import { validateRuntimeStateExpiredAuthority } from '../../../../runtime-state/RuntimeStateExpiredEntry.ts';
import { authTicketDigestKey } from '../../persistence/auth-storage-keys.ts';
import type {
  AuthMutationCommand,
  AuthMutationComputed,
  AuthMutationRead,
  ConsumeAuthAgentTicketCommand,
  IssueAuthAgentTicketsCommand,
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import {
  equalAuthJson,
  requireAuthTicket,
  validateIssueSessionRead,
  validateLiveSessionAuthority,
} from './auth-mutation-validation.ts';

type AuthAgentTicketMutationCommand = Extract<
  AuthMutationCommand,
  { kind: 'issue-agent-tickets' | 'consume-agent-ticket' }
>;

interface ValidateAuthAgentTicketMutationInput {
  readonly kind: AuthAgentTicketMutationCommand['kind'];
  readonly command: AuthAgentTicketMutationCommand;
  readonly read: AuthMutationRead;
  readonly computed: AuthMutationComputed;
}

interface ValidateIssuedAuthAgentTicketInput {
  readonly command: IssueAuthAgentTicketsCommand;
  readonly read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>;
  readonly computed: AuthMutationComputed;
  readonly index: number;
  readonly seenAgentIds: Set<string>;
  readonly seenSessionIds: Set<string>;
  readonly seenTicketDigests: Set<string>;
}

export function validateAuthAgentTicketMutation(
  validation: ValidateAuthAgentTicketMutationInput,
): void {
  switch (validation.kind) {
    case 'issue-agent-tickets':
      return validateAgentIssueRead(
        validation.command as IssueAuthAgentTicketsCommand,
        validation.read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
        validation.computed,
      );
    case 'consume-agent-ticket':
      return validateConsumeAgentTicketRead(
        validation.command as ConsumeAuthAgentTicketCommand,
        validation.read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>,
      );
  }
}

export function validateAgentIssueRead(
  command: IssueAuthAgentTicketsCommand,
  read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
  computed: AuthMutationComputed,
): void {
  validateAgentTicketBatchShape(command, read, computed);
  validateLiveSessionAuthority({
    expected: command.authority,
    read: read.authority,
    capturedAtEpochMs: command.capturedAtEpochMs,
    label: 'Agent ticket authority',
  });
  const seenAgentIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  const seenTicketDigests = new Set<string>();
  for (let index = 0; index < command.tickets.length; index += 1) {
    validateIssuedAuthAgentTicket({
      command,
      read,
      computed,
      index,
      seenAgentIds,
      seenSessionIds,
      seenTicketDigests,
    });
  }
}

export function validateConsumeAgentTicketRead(
  command: ConsumeAuthAgentTicketCommand,
  read: Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>,
): void {
  const ticket = requireAuthTicket(read.ticket).value;
  if (ticket.expiresAtEpochMs <= command.capturedAtEpochMs) {
    throw new AuthMutationRejectedError('Agent ticket is expired', 410);
  }
  if (
    !read.session ||
    read.session.value.sessionId !== ticket.sessionId ||
    read.session.value.clientId !== ticket.clientId ||
    read.session.value.accessTokenDigest !== ticket.accessTokenDigest
  ) {
    throw new AuthMutationRejectedError('Agent ticket authority differs', 401);
  }
}

function validateAgentTicketBatchShape(
  command: IssueAuthAgentTicketsCommand,
  read: Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>,
  computed: AuthMutationComputed,
): void {
  if (command.tickets.length === 0 || command.tickets.length !== computed.sessions.length) {
    throw new AuthMutationRejectedError('Agent ticket batch is invalid');
  }
  if (
    read.tickets.length !== command.tickets.length ||
    read.expiredTicketEntries.length !== command.tickets.length
  ) {
    throw new AuthMutationRejectedError('Agent ticket read batch is invalid');
  }
}

function validateIssuedAuthAgentTicket(validation: ValidateIssuedAuthAgentTicketInput): void {
  const ticket = validation.command.tickets[validation.index];
  validateAgentTicketAuthority(ticket, validation.command);
  validateAgentTicketLifecycle(ticket, validation.command.capturedAtEpochMs);
  validateAgentTicketIdentity(ticket, validation);
  validateIssueSessionRead(validation.computed.sessions[validation.index]?.session, {
    kind: 'issue-session',
    ...validation.read.sessions[validation.index],
  });
  const current = validation.read.tickets[validation.index];
  validateRuntimeStateExpiredAuthority(
    current,
    validation.read.expiredTicketEntries[validation.index],
    authTicketDigestKey(ticket.ticketDigest),
    'Agent ticket read',
  );
  if (
    current &&
    !equalAuthJson(current.value, validation.computed.agentTickets[validation.index])
  ) {
    throw new AuthMutationRejectedError('Agent ticket digest collision', 409);
  }
}

function validateAgentTicketAuthority(
  ticket: IssueAuthAgentTicketsCommand['tickets'][number],
  command: IssueAuthAgentTicketsCommand,
): void {
  if (
    ticket.clientId !== command.authority.clientId ||
    ticket.username !== command.authority.username
  ) {
    throw new AuthMutationRejectedError('Agent ticket authority differs', 403);
  }
}

function validateAgentTicketLifecycle(
  ticket: IssueAuthAgentTicketsCommand['tickets'][number],
  capturedAtEpochMs: number,
): void {
  if (
    ticket.issuedAtEpochMs !== capturedAtEpochMs ||
    ticket.sessionExpiresAtEpochMs <= capturedAtEpochMs ||
    ticket.ticketExpiresAtEpochMs <= capturedAtEpochMs ||
    ticket.ticketExpiresAtEpochMs > ticket.sessionExpiresAtEpochMs
  ) {
    throw new AuthMutationRejectedError('Agent ticket lifecycle is invalid', 410);
  }
}

function validateAgentTicketIdentity(
  ticket: IssueAuthAgentTicketsCommand['tickets'][number],
  validation: ValidateIssuedAuthAgentTicketInput,
): void {
  if (
    validation.seenAgentIds.has(ticket.agentId) ||
    validation.seenSessionIds.has(ticket.sessionId) ||
    validation.seenTicketDigests.has(ticket.ticketDigest)
  ) {
    throw new AuthMutationRejectedError('Agent ticket batch identity is duplicated', 409);
  }
  validation.seenAgentIds.add(ticket.agentId);
  validation.seenSessionIds.add(ticket.sessionId);
  validation.seenTicketDigests.add(ticket.ticketDigest);
}
