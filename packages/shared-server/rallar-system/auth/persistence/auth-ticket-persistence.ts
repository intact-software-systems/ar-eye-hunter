import { requireConditionalWrite } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryRead,
    type RuntimeStateEntryValue
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import {
    decodePersistedAgentSessionTicket,
    decodePersistedWebSocketTicket,
    type PersistedAgentSessionTicket,
    type PersistedAuthSession,
    type PersistedWebSocketTicket
} from './auth-persistence-contracts.ts';
import type { IssuedAgentSessionTicket, IssuedWebSocketTicket } from './auth-session-types.ts';
import {
    AGENT_SESSION_TICKETS_NAMESPACE,
    authTicketDigestKey,
    WS_AUTH_TICKETS_NAMESPACE
} from './auth-storage-keys.ts';

type FindSessionById = (sessionId: string) => Promise<PersistedAuthSession | undefined>;

export class AuthTicketPersistence extends RuntimeStateJsonStore {
    private readonly findSessionById: FindSessionById;

    constructor(
        repository: RuntimeStateRepositoryLike,
        findSessionById: FindSessionById
    ) {
        super(repository);
        this.findSessionById = findSessionById;
    }

    async putWebSocketTicket(ticket: IssuedWebSocketTicket): Promise<void> {
        const ticketDigest = await hashAuthSecret(ticket.ticket);
        const session = await this.findSessionById(ticket.sessionId);
        if (!session || session.clientId !== ticket.clientId) {
            throw new Error('Websocket ticket session is unavailable');
        }
        const persisted = decodePersistedWebSocketTicket({
            ticketDigest,
            accessTokenDigest: session.accessTokenDigest,
            sessionId: ticket.sessionId,
            clientId: ticket.clientId,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.expiresAtEpochMs
        });
        await this.putValue(
            WS_AUTH_TICKETS_NAMESPACE,
            authTicketDigestKey(ticketDigest),
            persisted,
            ticket.expiresAtEpochMs
        );
    }

    async consumeWebSocketTicket(ticket: string): Promise<PersistedAuthSession | undefined> {
        const issuedTicket = await this.findWebSocketTicketByDigestEntry(await hashAuthSecret(ticket));
        if (!issuedTicket) {
            return undefined;
        }
        requireConditionalWrite(
            await this.deleteWebSocketTicketStorageKeyIfRevision(
                issuedTicket.entry.key,
                issuedTicket.entry.revision
            )
        );
        return await this.readTicketSession(issuedTicket.value);
    }

    async putAgentSessionTicket(ticket: IssuedAgentSessionTicket): Promise<void> {
        const ticketDigest = await hashAuthSecret(ticket.ticket);
        const session = await this.findSessionById(ticket.sessionId);
        if (!session || session.clientId !== ticket.clientId) {
            throw new Error('Agent ticket session is unavailable');
        }
        const persisted = decodePersistedAgentSessionTicket({
            ticketDigest,
            accessTokenDigest: session.accessTokenDigest,
            sessionId: ticket.sessionId,
            clientId: ticket.clientId,
            agentId: ticket.agentId,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.expiresAtEpochMs
        });
        await this.putValue(
            AGENT_SESSION_TICKETS_NAMESPACE,
            authTicketDigestKey(ticketDigest),
            persisted,
            ticket.expiresAtEpochMs
        );
    }

    async consumeAgentSessionTicket(ticket: string): Promise<PersistedAuthSession | undefined> {
        const issuedTicket = await this.findAgentSessionTicketByDigestEntry(
            await hashAuthSecret(ticket)
        );
        if (!issuedTicket) {
            return undefined;
        }
        requireConditionalWrite(
            await this.deleteAgentSessionTicketStorageKeyIfRevision(
                issuedTicket.entry.key,
                issuedTicket.entry.revision
            )
        );
        return await this.readTicketSession(issuedTicket.value);
    }

    async insertWebSocketTicket(
        ticket: PersistedWebSocketTicket,
        expectedRevision: number | null = null
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedWebSocketTicket(ticket);
        return expectedRevision === null
            ? await this.putValueIfAbsent(
                WS_AUTH_TICKETS_NAMESPACE,
                authTicketDigestKey(persisted.ticketDigest),
                persisted,
                persisted.expiresAtEpochMs
            )
            : await this.putValueIfRevision(
                WS_AUTH_TICKETS_NAMESPACE,
                authTicketDigestKey(persisted.ticketDigest),
                persisted,
                persisted.expiresAtEpochMs,
                expectedRevision
            );
    }

    async findWebSocketTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
        return (await this.readWebSocketTicketByDigestEntry(ticketDigest)).value;
    }

    async readWebSocketTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryRead<PersistedWebSocketTicket>> {
        const read = await this.getEntryRead<unknown>(
            WS_AUTH_TICKETS_NAMESPACE,
            authTicketDigestKey(ticketDigest)
        );
        if (!read.value) {
            return { value: undefined, expiredEntry: read.expiredEntry };
        }
        const value = decodePersistedWebSocketTicket(read.value.value);
        if (value.ticketDigest !== ticketDigest) {
            throw new TypeError('Persisted websocket ticket digest identity differs');
        }
        return { value: { entry: read.value.entry, value }, expiredEntry: undefined };
    }

    async deleteWebSocketTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            WS_AUTH_TICKETS_NAMESPACE,
            authTicketDigestKey(ticketDigest),
            expectedRevision
        );
    }

    async deleteWebSocketTicketStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            WS_AUTH_TICKETS_NAMESPACE,
            storageKey,
            expectedRevision
        );
    }

    async insertAgentSessionTicket(
        ticket: PersistedAgentSessionTicket,
        expectedRevision: number | null = null
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAgentSessionTicket(ticket);
        return expectedRevision === null
            ? await this.putValueIfAbsent(
                AGENT_SESSION_TICKETS_NAMESPACE,
                authTicketDigestKey(persisted.ticketDigest),
                persisted,
                persisted.expiresAtEpochMs
            )
            : await this.putValueIfRevision(
                AGENT_SESSION_TICKETS_NAMESPACE,
                authTicketDigestKey(persisted.ticketDigest),
                persisted,
                persisted.expiresAtEpochMs,
                expectedRevision
            );
    }

    async findAgentSessionTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
        return (await this.readAgentSessionTicketByDigestEntry(ticketDigest)).value;
    }

    async readAgentSessionTicketByDigestEntry(
        ticketDigest: string
    ): Promise<RuntimeStateEntryRead<PersistedAgentSessionTicket>> {
        const read = await this.getEntryRead<unknown>(
            AGENT_SESSION_TICKETS_NAMESPACE,
            authTicketDigestKey(ticketDigest)
        );
        if (!read.value) {
            return { value: undefined, expiredEntry: read.expiredEntry };
        }
        const value = decodePersistedAgentSessionTicket(read.value.value);
        if (value.ticketDigest !== ticketDigest) {
            throw new TypeError('Persisted agent ticket digest identity differs');
        }
        return { value: { entry: read.value.entry, value }, expiredEntry: undefined };
    }

    async deleteAgentSessionTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AGENT_SESSION_TICKETS_NAMESPACE,
            authTicketDigestKey(ticketDigest),
            expectedRevision
        );
    }

    async deleteAgentSessionTicketStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AGENT_SESSION_TICKETS_NAMESPACE,
            storageKey,
            expectedRevision
        );
    }

    private async readTicketSession(
        issuedTicket: Pick<PersistedWebSocketTicket, 'sessionId' | 'clientId'>
    ): Promise<PersistedAuthSession | undefined> {
        const session = await this.findSessionById(issuedTicket.sessionId);
        return session?.clientId === issuedTicket.clientId ? session : undefined;
    }
}
