import type {
  RuntimeStateConditionalDeleteResult,
  RuntimeStateConditionalWriteResult,
  RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import type {
  RuntimeStateEntryRead,
  RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
  PersistedAgentSessionTicket,
  PersistedAuthSession,
  PersistedWebSocketTicket,
} from './auth-persistence-contracts.ts';
import { AuthSessionPersistence } from './auth-session-persistence.ts';
import type { IssuedAgentSessionTicket, IssuedWebSocketTicket } from './auth-session-types.ts';
import { AuthTicketPersistence } from './auth-ticket-persistence.ts';

export {
  decodePersistedAgentSessionTicket,
  decodePersistedAuthSession,
  decodePersistedWebSocketTicket,
  type PersistedAgentSessionTicket,
  type PersistedAuthSession,
  type PersistedWebSocketTicket,
} from './auth-persistence-contracts.ts';
export {
  AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS,
  AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT,
} from './auth-legacy-compatibility.ts';
export { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
export type {
  IssuedAgentSessionTicket,
  IssuedAuthSession,
  IssuedWebSocketTicket,
} from './auth-session-types.ts';

export class AuthSessionRepository extends AuthSessionPersistence {
  private readonly tickets: AuthTicketPersistence;

  constructor(repository: RuntimeStateRepositoryLike) {
    super(repository);
    this.tickets = new AuthTicketPersistence(
      repository,
      async (sessionId) => await this.findBySessionId(sessionId),
    );
  }

  async putWebSocketTicket(ticket: IssuedWebSocketTicket): Promise<void> {
    await this.tickets.putWebSocketTicket(ticket);
  }

  async consumeWebSocketTicket(ticket: string): Promise<PersistedAuthSession | undefined> {
    return await this.tickets.consumeWebSocketTicket(ticket);
  }

  async putAgentSessionTicket(ticket: IssuedAgentSessionTicket): Promise<void> {
    await this.tickets.putAgentSessionTicket(ticket);
  }

  async consumeAgentSessionTicket(ticket: string): Promise<PersistedAuthSession | undefined> {
    return await this.tickets.consumeAgentSessionTicket(ticket);
  }

  async insertWebSocketTicket(
    ticket: PersistedWebSocketTicket,
    expectedRevision: number | null = null,
  ): Promise<RuntimeStateConditionalWriteResult> {
    return await this.tickets.insertWebSocketTicket(ticket, expectedRevision);
  }

  async findWebSocketTicketByDigestEntry(
    ticketDigest: string,
  ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
    return await this.tickets.findWebSocketTicketByDigestEntry(ticketDigest);
  }

  async readWebSocketTicketByDigestEntry(
    ticketDigest: string,
  ): Promise<RuntimeStateEntryRead<PersistedWebSocketTicket>> {
    return await this.tickets.readWebSocketTicketByDigestEntry(ticketDigest);
  }

  async deleteWebSocketTicketIfRevision(
    ticketDigest: string,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalDeleteResult> {
    return await this.tickets.deleteWebSocketTicketIfRevision(ticketDigest, expectedRevision);
  }

  async deleteWebSocketTicketStorageKeyIfRevision(
    storageKey: string,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalDeleteResult> {
    return await this.tickets.deleteWebSocketTicketStorageKeyIfRevision(
      storageKey,
      expectedRevision,
    );
  }

  async insertAgentSessionTicket(
    ticket: PersistedAgentSessionTicket,
    expectedRevision: number | null = null,
  ): Promise<RuntimeStateConditionalWriteResult> {
    return await this.tickets.insertAgentSessionTicket(ticket, expectedRevision);
  }

  async findAgentSessionTicketByDigestEntry(
    ticketDigest: string,
  ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
    return await this.tickets.findAgentSessionTicketByDigestEntry(ticketDigest);
  }

  async readAgentSessionTicketByDigestEntry(
    ticketDigest: string,
  ): Promise<RuntimeStateEntryRead<PersistedAgentSessionTicket>> {
    return await this.tickets.readAgentSessionTicketByDigestEntry(ticketDigest);
  }

  async deleteAgentSessionTicketIfRevision(
    ticketDigest: string,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalDeleteResult> {
    return await this.tickets.deleteAgentSessionTicketIfRevision(ticketDigest, expectedRevision);
  }

  async deleteAgentSessionTicketStorageKeyIfRevision(
    storageKey: string,
    expectedRevision: number,
  ): Promise<RuntimeStateConditionalDeleteResult> {
    return await this.tickets.deleteAgentSessionTicketStorageKeyIfRevision(
      storageKey,
      expectedRevision,
    );
  }
}
