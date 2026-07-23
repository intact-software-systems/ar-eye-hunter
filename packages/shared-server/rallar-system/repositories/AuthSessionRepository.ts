import type { AuthSession } from '@shared/api/api-config.ts';
import {
    type RuntimeStateConditionalDeleteResult,
    type RuntimeStateConditionalWriteResult,
    type RuntimeStateRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue,
} from '../../runtime-state/RuntimeStateJsonStore.ts';
import { requireConditionalWrite } from '../../runtime-state/optimistic-runtime-state-write.ts';

const AUTH_SESSIONS_BY_TOKEN_NAMESPACE = 'auth-sessions:by-token';
const AUTH_SESSIONS_BY_SESSION_NAMESPACE = 'auth-sessions:by-session';
const WS_AUTH_TICKETS_NAMESPACE = 'auth-sessions:ws-tickets';
const AGENT_SESSION_TICKETS_NAMESPACE = 'auth-sessions:agent-session-tickets';

export type IssuedAuthSession = AuthSession &
    Readonly<{
        issuedAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;

export type IssuedWebSocketTicket = Readonly<{
    ticket: string;
    sessionId: string;
    clientId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type PersistedWebSocketTicket = Readonly<{
    ticketDigest: string;
    accessTokenDigest: string;
    sessionId: string;
    clientId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type IssuedAgentSessionTicket = Readonly<{
    ticket: string;
    sessionId: string;
    clientId: string;
    agentId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type PersistedAgentSessionTicket = Readonly<{
    ticketDigest: string;
    accessTokenDigest: string;
    sessionId: string;
    clientId: string;
    agentId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export class AuthSessionRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putSession(session: IssuedAuthSession): Promise<void> {
        const accessTokenDigest = await hashAuthSecret(session.accessToken);
        await this.putValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
            session,
            session.expiresAtEpochMs,
        );
        await this.putValue(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(session.sessionId),
            session,
            session.expiresAtEpochMs,
        );
    }

    async insertSessionByToken(
        session: IssuedAuthSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.insertSessionByTokenDigest(
            session,
            await hashAuthSecret(session.accessToken),
        );
    }

    async insertSessionByTokenDigest(
        session: IssuedAuthSession,
        accessTokenDigest: string,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
            session,
            session.expiresAtEpochMs,
        );
    }

    async insertSessionBySessionId(
        session: IssuedAuthSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(session.sessionId),
            session,
            session.expiresAtEpochMs,
        );
    }

    async findByAccessToken(accessToken: string): Promise<IssuedAuthSession | undefined> {
        const accessTokenDigest = await hashAuthSecret(accessToken);
        return await this.getValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
        ) ?? await this.getValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.legacyTokenKey(accessToken),
        );
    }

    async findBySessionId(sessionId: string): Promise<IssuedAuthSession | undefined> {
        return await this.getValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(sessionId),
        );
    }

    async findSessionByAccessTokenEntry(
        accessToken: string,
    ): Promise<RuntimeStateEntryValue<IssuedAuthSession> | undefined> {
        return await this.findSessionByAccessTokenDigestEntry(
            await hashAuthSecret(accessToken),
        ) ?? await this.findLegacySessionByAccessTokenEntry(accessToken);
    }

    async findLegacySessionByAccessTokenEntry(
        accessToken: string,
    ): Promise<RuntimeStateEntryValue<IssuedAuthSession> | undefined> {
        return await this.getEntryValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.legacyTokenKey(accessToken),
        );
    }

    async findSessionByAccessTokenDigestEntry(
        accessTokenDigest: string,
    ): Promise<RuntimeStateEntryValue<IssuedAuthSession> | undefined> {
        return await this.getEntryValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
        );
    }

    async findSessionBySessionIdEntry(
        sessionId: string,
    ): Promise<RuntimeStateEntryValue<IssuedAuthSession> | undefined> {
        return await this.getEntryValue<IssuedAuthSession>(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(sessionId),
        );
    }

    async deleteSession(session: IssuedAuthSession): Promise<void> {
        const accessTokenDigest = await hashAuthSecret(session.accessToken);
        await this.deleteValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
        );
        await this.deleteValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.legacyTokenKey(session.accessToken),
        );
        await this.deleteValue(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(session.sessionId),
        );
    }

    async deleteSessionBySessionIdIfRevision(
        sessionId: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(sessionId),
            expectedRevision,
        );
    }

    async deleteSessionByAccessTokenDigestIfRevision(
        accessTokenDigest: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
            expectedRevision,
        );
    }

    async deleteLegacySessionByAccessTokenIfRevision(
        accessToken: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.legacyTokenKey(accessToken),
            expectedRevision,
        );
    }

    async deleteSessionTokenStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            storageKey,
            expectedRevision,
        );
    }

    async putWebSocketTicket(ticket: IssuedWebSocketTicket): Promise<void> {
        const ticketDigest = await hashAuthSecret(ticket.ticket);
        const session = await this.findBySessionId(ticket.sessionId);
        if (!session || session.clientId !== ticket.clientId) {
            throw new Error('Websocket ticket session is unavailable');
        }
        await this.putValue(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
            {
                ticketDigest,
                accessTokenDigest: await hashAuthSecret(session.accessToken),
                sessionId: ticket.sessionId,
                clientId: ticket.clientId,
                issuedAtEpochMs: ticket.issuedAtEpochMs,
                expiresAtEpochMs: ticket.expiresAtEpochMs,
            } satisfies PersistedWebSocketTicket,
            ticket.expiresAtEpochMs,
        );
    }

    async consumeWebSocketTicket(ticket: string): Promise<IssuedAuthSession | undefined> {
        const ticketDigest = await hashAuthSecret(ticket);
        const issuedTicket = await this.findWebSocketTicketByDigestEntry(ticketDigest);
        if (!issuedTicket) return undefined;
        requireConditionalWrite(
            await this.deleteWebSocketTicketStorageKeyIfRevision(
                issuedTicket.entry.key,
                issuedTicket.entry.revision,
            ),
        );
        return await this.readTicketSession(issuedTicket.value);
    }

    async putAgentSessionTicket(ticket: IssuedAgentSessionTicket): Promise<void> {
        const ticketDigest = await hashAuthSecret(ticket.ticket);
        const session = await this.findBySessionId(ticket.sessionId);
        if (!session || session.clientId !== ticket.clientId) {
            throw new Error('Agent ticket session is unavailable');
        }
        await this.putValue(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
            {
                ticketDigest,
                accessTokenDigest: await hashAuthSecret(session.accessToken),
                sessionId: ticket.sessionId,
                clientId: ticket.clientId,
                agentId: ticket.agentId,
                issuedAtEpochMs: ticket.issuedAtEpochMs,
                expiresAtEpochMs: ticket.expiresAtEpochMs,
            } satisfies PersistedAgentSessionTicket,
            ticket.expiresAtEpochMs,
        );
    }

    async consumeAgentSessionTicket(ticket: string): Promise<IssuedAuthSession | undefined> {
        const ticketDigest = await hashAuthSecret(ticket);
        const issuedTicket = await this.findAgentSessionTicketByDigestEntry(ticketDigest);
        if (!issuedTicket) return undefined;
        requireConditionalWrite(
            await this.deleteAgentSessionTicketStorageKeyIfRevision(
                issuedTicket.entry.key,
                issuedTicket.entry.revision,
            ),
        );
        return await this.readTicketSession(issuedTicket.value);
    }

    async insertWebSocketTicket(
        ticket: PersistedWebSocketTicket,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticket.ticketDigest),
            ticket,
            ticket.expiresAtEpochMs,
        );
    }

    async findWebSocketTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
        return await this.getEntryValue<PersistedWebSocketTicket>(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
        ) ?? await this.findLegacyWebSocketTicketByDigestEntry(ticketDigest);
    }

    async deleteWebSocketTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
            expectedRevision,
        );
    }

    async deleteWebSocketTicketStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            WS_AUTH_TICKETS_NAMESPACE,
            storageKey,
            expectedRevision,
        );
    }

    async insertAgentSessionTicket(
        ticket: PersistedAgentSessionTicket,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(ticket.ticketDigest),
            ticket,
            ticket.expiresAtEpochMs,
        );
    }

    async findAgentSessionTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
        return await this.getEntryValue<PersistedAgentSessionTicket>(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
        ) ?? await this.findLegacyAgentTicketByDigestEntry(ticketDigest);
    }

    async deleteAgentSessionTicketIfRevision(
        ticketDigest: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
            expectedRevision,
        );
    }

    async deleteAgentSessionTicketStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AGENT_SESSION_TICKETS_NAMESPACE,
            storageKey,
            expectedRevision,
        );
    }

    private async readTicketSession(
        issuedTicket: Pick<PersistedWebSocketTicket, 'sessionId' | 'clientId'>,
    ): Promise<IssuedAuthSession | undefined> {
        const session = await this.findBySessionId(issuedTicket.sessionId);
        if (!session || session.clientId !== issuedTicket.clientId) {
            return undefined;
        }

        return session;
    }

    private tokenKey(accessTokenDigest: string): string {
        return this.idKey('token-digest', accessTokenDigest);
    }

    private legacyTokenKey(accessToken: string): string {
        return this.idKey('token', accessToken);
    }

    private sessionKey(sessionId: string): string {
        return this.idKey('session', sessionId);
    }

    private ticketKey(ticketDigest: string): string {
        return this.idKey('ticket-digest', ticketDigest);
    }

    private legacyTicketKey(ticket: string): string {
        return this.idKey('ticket', ticket);
    }

    private async findLegacyWebSocketTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
        const legacy = await this.findLegacyTicketByDigestEntry(
            WS_AUTH_TICKETS_NAMESPACE,
            ticketDigest,
            false,
        );
        return legacy as RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined;
    }

    private async findLegacyAgentTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
        const legacy = await this.findLegacyTicketByDigestEntry(
            AGENT_SESSION_TICKETS_NAMESPACE,
            ticketDigest,
            true,
        );
        return legacy as RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined;
    }

    private async findLegacyTicketByDigestEntry(
        namespace: string,
        ticketDigest: string,
        agentTicket: boolean,
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket | PersistedAgentSessionTicket> | undefined> {
        for (const entry of await this.repository.findAllEntries(namespace)) {
            const live = await this.toLiveEntryValue<unknown>(namespace, entry);
            if (!live || !isLegacyTicket(live.value, agentTicket)) continue;
            if (live.entry.key !== this.legacyTicketKey(live.value.ticket)) continue;
            if (await hashAuthSecret(live.value.ticket) !== ticketDigest) continue;
            const session = await this.findBySessionId(live.value.sessionId);
            if (!session || session.clientId !== live.value.clientId) continue;
            return {
                entry: live.entry,
                value: {
                    ticketDigest,
                    accessTokenDigest: await hashAuthSecret(session.accessToken),
                    sessionId: live.value.sessionId,
                    clientId: live.value.clientId,
                    ...(agentTicket ? { agentId: live.value.agentId } : {}),
                    issuedAtEpochMs: live.value.issuedAtEpochMs,
                    expiresAtEpochMs: live.value.expiresAtEpochMs,
                } as PersistedWebSocketTicket | PersistedAgentSessionTicket,
            };
        }
        return undefined;
    }
}

function isLegacyTicket(
    value: unknown,
    agentTicket: boolean,
): value is IssuedWebSocketTicket & Partial<IssuedAgentSessionTicket> {
    if (typeof value !== 'object' || value === null || !('ticket' in value)) return false;
    const ticket = value as Partial<IssuedAgentSessionTicket>;
    return typeof ticket.ticket === 'string' && typeof ticket.sessionId === 'string' &&
        typeof ticket.clientId === 'string' && typeof ticket.issuedAtEpochMs === 'number' &&
        typeof ticket.expiresAtEpochMs === 'number' &&
        (!agentTicket || typeof ticket.agentId === 'string');
}

export async function hashAuthSecret(secret: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(secret),
    );
    return toBase64Url(new Uint8Array(digest));
}

function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}
