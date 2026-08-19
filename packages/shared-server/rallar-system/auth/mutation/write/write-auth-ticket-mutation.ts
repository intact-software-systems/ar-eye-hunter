import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { AuthSessionRepository } from '../../persistence/auth-session-repository.ts';
import { requireAuthTicket } from '../validate/auth-mutation-validation.ts';
import type { AuthMutationComputed, AuthMutationRead } from '../auth-mutation-contracts.ts';
import { writeAuthSession } from './write-auth-session.ts';

export async function writeAuthTicketMutation(
  sessions: AuthSessionRepository,
  computed: AuthMutationComputed,
): Promise<void> {
  switch (computed.command.kind) {
    case 'issue-ws-ticket':
      return await writeAuthWebSocketTicketIssue(sessions, computed);
    case 'consume-ws-ticket':
      return await writeAuthWebSocketTicketConsume(sessions, computed);
    case 'issue-agent-tickets':
      return await writeAuthAgentTicketsIssue(sessions, computed);
    case 'consume-agent-ticket':
      return await writeAuthAgentTicketConsume(sessions, computed);
    case 'register-user':
    case 'issue-session':
    case 'logout-session':
      throw new TypeError('Auth ticket write received a non-ticket mutation');
  }
}

async function writeAuthWebSocketTicketIssue(
  sessions: AuthSessionRepository,
  computed: AuthMutationComputed,
): Promise<void> {
  const command = computed.command as Extract<
    AuthMutationComputed['command'],
    { kind: 'issue-ws-ticket' }
  >;
  const read = computed.read as Extract<AuthMutationRead, { kind: 'issue-ws-ticket' }>;
  requireConditionalWrite(
    await sessions.insertWebSocketTicket(
      command.ticketRecord,
      read.expiredTicketEntry?.revision ?? null,
    ),
  );
}

async function writeAuthWebSocketTicketConsume(
  sessions: AuthSessionRepository,
  computed: AuthMutationComputed,
): Promise<void> {
  const read = computed.read as Extract<AuthMutationRead, { kind: 'consume-ws-ticket' }>;
  const ticket = requireAuthTicket(read.ticket);
  requireConditionalWrite(
    await sessions.deleteWebSocketTicketStorageKeyIfRevision(
      ticket.entry.key,
      ticket.entry.revision,
    ),
  );
}

async function writeAuthAgentTicketsIssue(
  sessions: AuthSessionRepository,
  computed: AuthMutationComputed,
): Promise<void> {
  const read = computed.read as Extract<AuthMutationRead, { kind: 'issue-agent-tickets' }>;
  for (let index = 0; index < computed.sessions.length; index += 1) {
    await writeAuthSession(sessions, computed.sessions[index], read.sessions[index]);
    requireConditionalWrite(
      await sessions.insertAgentSessionTicket(
        computed.agentTickets[index],
        read.expiredTicketEntries[index]?.revision ?? null,
      ),
    );
  }
}

async function writeAuthAgentTicketConsume(
  sessions: AuthSessionRepository,
  computed: AuthMutationComputed,
): Promise<void> {
  const read = computed.read as Extract<AuthMutationRead, { kind: 'consume-agent-ticket' }>;
  const ticket = requireAuthTicket(read.ticket);
  requireConditionalWrite(
    await sessions.deleteAgentSessionTicketStorageKeyIfRevision(
      ticket.entry.key,
      ticket.entry.revision,
    ),
  );
}
