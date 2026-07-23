import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
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
export { hashAuthSecret } from './auth-secret-digest.ts';
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

    async consumeWebSocketTicket(
        ticket: string,
    ): Promise<PersistedAuthSession | undefined> {
        return await this.tickets.consumeWebSocketTicket(ticket);
    }

    async putAgentSessionTicket(ticket: IssuedAgentSessionTicket): Promise<void> {
        await this.tickets.putAgentSessionTicket(ticket);
    }

    async consumeAgentSessionTicket(
        ticket: string,
    ): Promise<PersistedAuthSession | undefined> {
        return await this.tickets.consumeAgentSessionTicket(ticket);
    }

    async insertWebSocketTicket(
        ticket: PersistedWebSocketTicket,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.tickets.insertWebSocketTicket(ticket);
    }

    async findWebSocketTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
        return await this.tickets.findWebSocketTicketByDigestEntry(ticketDigest);
    }

    async deleteWebSocketTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.tickets.deleteWebSocketTicketIfRevision(
            ticketDigest,
            expectedRevision,
        );
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
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.tickets.insertAgentSessionTicket(ticket);
    }

    async findAgentSessionTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
        return await this.tickets.findAgentSessionTicketByDigestEntry(ticketDigest);
    }

    async deleteAgentSessionTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.tickets.deleteAgentSessionTicketIfRevision(
            ticketDigest,
            expectedRevision,
        );
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
