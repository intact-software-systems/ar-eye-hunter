import type { RuntimeStateEntryRead, RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import { AuthSessionPersistence } from './auth-session-persistence.ts';
import type { IssuedAgentSessionTicket, IssuedWebSocketTicket } from './auth-session-types.ts';
import { AuthTicketPersistence } from './auth-ticket-persistence.ts';
import type { PersistedAuthSession } from './persisted-auth-session.ts';
import type { PersistedAgentSessionTicket, PersistedWebSocketTicket } from './persisted-auth-ticket.ts';

export class AuthSessionRepository extends AuthSessionPersistence {
    private readonly tickets: AuthTicketPersistence;

    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
        this.tickets = new AuthTicketPersistence(
            repository,
            async (sessionId) => await this.findBySessionId(sessionId)
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

    async findWebSocketTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
        return await this.tickets.findWebSocketTicketByDigestEntry(ticketDigest);
    }

    async readWebSocketTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryRead<PersistedWebSocketTicket>> {
        return await this.tickets.readWebSocketTicketByDigestEntry(ticketDigest);
    }

    async deleteWebSocketTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.tickets.deleteWebSocketTicketIfRevision(ticketDigest, expectedRevision);
    }

    async deleteWebSocketTicketStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.tickets.deleteWebSocketTicketStorageKeyIfRevision(
            storageKey,
            expectedRevision
        );
    }

    async findAgentSessionTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
        return await this.tickets.findAgentSessionTicketByDigestEntry(ticketDigest);
    }

    async readAgentSessionTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryRead<PersistedAgentSessionTicket>> {
        return await this.tickets.readAgentSessionTicketByDigestEntry(ticketDigest);
    }

    async deleteAgentSessionTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.tickets.deleteAgentSessionTicketIfRevision(ticketDigest, expectedRevision);
    }

    async deleteAgentSessionTicketStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.tickets.deleteAgentSessionTicketStorageKeyIfRevision(
            storageKey,
            expectedRevision
        );
    }
}
