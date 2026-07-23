import type { AuthSession } from '@shared/api/api-config.ts';
import {
    isRuntimeStatePrefixPageRepositoryLike,
    type RuntimeStateConditionalDeleteResult,
    type RuntimeStateConditionalWriteResult,
    type RuntimeStateEntry,
    type RuntimeStateRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    type RuntimeStateEntryValue,
    RuntimeStateJsonStore,
} from '../../runtime-state/RuntimeStateJsonStore.ts';
import { requireConditionalWrite } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    decodePersistedAgentSessionTicket,
    decodePersistedAuthSession,
    decodePersistedWebSocketTicket,
    type PersistedAgentSessionTicket,
    type PersistedAuthSession,
    type PersistedWebSocketTicket,
} from './auth-persistence-contracts.ts';

export {
    decodePersistedAgentSessionTicket,
    decodePersistedAuthSession,
    decodePersistedWebSocketTicket,
    type PersistedAgentSessionTicket,
    type PersistedAuthSession,
    type PersistedWebSocketTicket,
} from './auth-persistence-contracts.ts';

const AUTH_SESSIONS_BY_TOKEN_NAMESPACE = 'auth-sessions:by-token';
const AUTH_SESSIONS_BY_SESSION_NAMESPACE = 'auth-sessions:by-session';
const WS_AUTH_TICKETS_NAMESPACE = 'auth-sessions:ws-tickets';
const AGENT_SESSION_TICKETS_NAMESPACE = 'auth-sessions:agent-session-tickets';

export type IssuedAuthSession =
    & AuthSession
    & Readonly<{
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

export type IssuedAgentSessionTicket = Readonly<{
    ticket: string;
    sessionId: string;
    clientId: string;
    agentId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

// Operators must migrate plaintext-key auth rows before this removal boundary.
// Delete the compatibility readers after the deadline; do not extend them silently.
export const AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS = Date.parse(
    '2026-12-31T00:00:00.000Z',
);
export const AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT = 128;

export class AuthSessionRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putSession(session: IssuedAuthSession): Promise<void> {
        const persisted = await toPersistedAuthSession(session);
        await this.putValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(persisted.accessTokenDigest),
            persisted,
            session.expiresAtEpochMs,
        );
        await this.putValue(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(session.sessionId),
            persisted,
            session.expiresAtEpochMs,
        );
    }

    async insertSessionByToken(
        session: IssuedAuthSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.insertSessionByTokenDigest(await toPersistedAuthSession(session));
    }

    async insertSessionByTokenDigest(
        session: PersistedAuthSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAuthSession(session);
        return await this.putValueIfAbsent(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(persisted.accessTokenDigest),
            persisted,
            persisted.expiresAtEpochMs,
        );
    }

    async insertSessionBySessionId(
        session: PersistedAuthSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAuthSession(session);
        return await this.putValueIfAbsent(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(persisted.sessionId),
            persisted,
            persisted.expiresAtEpochMs,
        );
    }

    async findByAccessToken(accessToken: string): Promise<IssuedAuthSession | undefined> {
        const accessTokenDigest = await hashAuthSecret(accessToken);
        const persisted = await this.findSessionByAccessTokenDigestEntry(accessTokenDigest) ??
            await this.findLegacySessionByAccessTokenEntry(accessToken);
        return persisted ? toIssuedAuthSession(persisted.value, accessToken) : undefined;
    }

    async findBySessionId(sessionId: string): Promise<PersistedAuthSession | undefined> {
        return (await this.findSessionBySessionIdEntry(sessionId))?.value;
    }

    async findSessionByAccessTokenEntry(
        accessToken: string,
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        return await this.findSessionByAccessTokenDigestEntry(
            await hashAuthSecret(accessToken),
        ) ?? await this.findLegacySessionByAccessTokenEntry(accessToken);
    }

    async findLegacySessionByAccessTokenEntry(
        accessToken: string,
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        this.requireLegacyPlaintextCompatibility();
        const entry = await this.getEntryValue<unknown>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.legacyTokenKey(accessToken),
        );
        if (!entry) return undefined;
        const legacy = decodeLegacyIssuedAuthSession(entry.value);
        if (legacy.accessToken !== accessToken) {
            throw new TypeError('Legacy auth session token identity differs');
        }
        return { entry: entry.entry, value: await toPersistedAuthSession(legacy) };
    }

    async findLegacySessionByAccessTokenDigestEntry(
        accessTokenDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        for (
            const entry of await this.readBoundedLegacyPage(
                AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
                this.legacyTokenKey(''),
            )
        ) {
            const live = await this.toLiveEntryValue<unknown>(
                AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
                entry,
            );
            if (!live) continue;
            if (!live.entry.key.startsWith(this.legacyTokenKey(''))) continue;
            const legacy = decodeLegacyIssuedAuthSession(live.value);
            if (live.entry.key !== this.legacyTokenKey(legacy.accessToken)) continue;
            if (await hashAuthSecret(legacy.accessToken) !== accessTokenDigest) continue;
            return {
                entry: live.entry,
                value: await toPersistedAuthSession(legacy),
            };
        }
        return undefined;
    }

    async findSessionByAccessTokenDigestEntry(
        accessTokenDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        const entry = await this.getEntryValue<unknown>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            this.tokenKey(accessTokenDigest),
        );
        if (!entry) return undefined;
        const value = decodePersistedAuthSession(entry.value);
        if (value.accessTokenDigest !== accessTokenDigest) {
            throw new TypeError('Persisted auth session token digest identity differs');
        }
        return { entry: entry.entry, value };
    }

    async findSessionBySessionIdEntry(
        sessionId: string,
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        const entry = await this.getEntryValue<unknown>(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            this.sessionKey(sessionId),
        );
        if (!entry) return undefined;
        const value = await this.decodePersistedOrLegacyAuthSession(entry.value);
        if (value.sessionId !== sessionId) {
            throw new TypeError('Persisted auth session id identity differs');
        }
        return { entry: entry.entry, value };
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
        const persisted = decodePersistedWebSocketTicket({
            ticketDigest,
            accessTokenDigest: session.accessTokenDigest,
            sessionId: ticket.sessionId,
            clientId: ticket.clientId,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.expiresAtEpochMs,
        });
        await this.putValue(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
            persisted,
            ticket.expiresAtEpochMs,
        );
    }

    async consumeWebSocketTicket(ticket: string): Promise<PersistedAuthSession | undefined> {
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
        const persisted = decodePersistedAgentSessionTicket({
            ticketDigest,
            accessTokenDigest: session.accessTokenDigest,
            sessionId: ticket.sessionId,
            clientId: ticket.clientId,
            agentId: ticket.agentId,
            issuedAtEpochMs: ticket.issuedAtEpochMs,
            expiresAtEpochMs: ticket.expiresAtEpochMs,
        });
        await this.putValue(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
            persisted,
            ticket.expiresAtEpochMs,
        );
    }

    async consumeAgentSessionTicket(ticket: string): Promise<PersistedAuthSession | undefined> {
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
        const persisted = decodePersistedWebSocketTicket(ticket);
        return await this.putValueIfAbsent(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(persisted.ticketDigest),
            persisted,
            persisted.expiresAtEpochMs,
        );
    }

    async findWebSocketTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedWebSocketTicket> | undefined> {
        const entry = await this.getEntryValue<unknown>(
            WS_AUTH_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
        );
        if (!entry) return await this.findLegacyWebSocketTicketByDigestEntry(ticketDigest);
        const value = decodePersistedWebSocketTicket(entry.value);
        if (value.ticketDigest !== ticketDigest) {
            throw new TypeError('Persisted websocket ticket digest identity differs');
        }
        return { entry: entry.entry, value };
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
        const persisted = decodePersistedAgentSessionTicket(ticket);
        return await this.putValueIfAbsent(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(persisted.ticketDigest),
            persisted,
            persisted.expiresAtEpochMs,
        );
    }

    async findAgentSessionTicketByDigestEntry(
        ticketDigest: string,
    ): Promise<RuntimeStateEntryValue<PersistedAgentSessionTicket> | undefined> {
        const entry = await this.getEntryValue<unknown>(
            AGENT_SESSION_TICKETS_NAMESPACE,
            this.ticketKey(ticketDigest),
        );
        if (!entry) return await this.findLegacyAgentTicketByDigestEntry(ticketDigest);
        const value = decodePersistedAgentSessionTicket(entry.value);
        if (value.ticketDigest !== ticketDigest) {
            throw new TypeError('Persisted agent ticket digest identity differs');
        }
        return { entry: entry.entry, value };
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
    ): Promise<PersistedAuthSession | undefined> {
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
    ): Promise<
        RuntimeStateEntryValue<PersistedWebSocketTicket | PersistedAgentSessionTicket> | undefined
    > {
        for (
            const entry of await this.readBoundedLegacyPage(
                namespace,
                this.legacyTicketKey(''),
            )
        ) {
            const live = await this.toLiveEntryValue<unknown>(namespace, entry);
            if (!live) continue;
            const legacy = decodeLegacyTicket(live.value, agentTicket);
            if (live.entry.key !== this.legacyTicketKey(legacy.ticket)) continue;
            if (await hashAuthSecret(legacy.ticket) !== ticketDigest) continue;
            const session = await this.findBySessionId(legacy.sessionId);
            if (!session || session.clientId !== legacy.clientId) continue;
            return {
                entry: live.entry,
                value: {
                    ticketDigest,
                    accessTokenDigest: session.accessTokenDigest,
                    sessionId: legacy.sessionId,
                    clientId: legacy.clientId,
                    ...(agentTicket ? { agentId: legacy.agentId } : {}),
                    issuedAtEpochMs: legacy.issuedAtEpochMs,
                    expiresAtEpochMs: legacy.expiresAtEpochMs,
                } as PersistedWebSocketTicket | PersistedAgentSessionTicket,
            };
        }
        return undefined;
    }

    private async decodePersistedOrLegacyAuthSession(
        input: unknown,
    ): Promise<PersistedAuthSession> {
        try {
            return decodePersistedAuthSession(input);
        } catch (persistedError) {
            try {
                this.requireLegacyPlaintextCompatibility();
                return await toPersistedAuthSession(decodeLegacyIssuedAuthSession(input));
            } catch {
                throw persistedError;
            }
        }
    }

    private async readBoundedLegacyPage(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.requireLegacyPlaintextCompatibility();
        if (!isRuntimeStatePrefixPageRepositoryLike(this.repository)) {
            throw new TypeError(
                'Legacy plaintext auth compatibility requires bounded pagination',
            );
        }
        const entries = await this.repository.findEntriesByPrefixPage(
            namespace,
            keyPrefix,
            { limit: AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT + 1 },
        );
        if (entries.length > AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT) {
            throw new RangeError('Legacy plaintext auth compatibility scan limit exceeded');
        }
        return entries;
    }

    private requireLegacyPlaintextCompatibility(): void {
        if (Date.now() >= AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS) {
            throw new TypeError('Legacy plaintext auth compatibility has ended');
        }
    }
}

function decodeLegacyTicket(
    input: unknown,
    agentTicket: boolean,
): IssuedWebSocketTicket & Partial<Readonly<{ agentId: string }>> {
    const label = agentTicket ? 'Legacy agent ticket' : 'Legacy websocket ticket';
    const value = requirePlainRecord(input, label);
    requireExactKeys(
        value,
        agentTicket
            ? [
                'ticket',
                'sessionId',
                'clientId',
                'agentId',
                'issuedAtEpochMs',
                'expiresAtEpochMs',
            ]
            : [
                'ticket',
                'sessionId',
                'clientId',
                'issuedAtEpochMs',
                'expiresAtEpochMs',
            ],
    );
    for (const field of ['ticket', 'sessionId', 'clientId'] as const) {
        requireNonEmptyString(value[field], `${label} ${field}`);
    }
    if (agentTicket) requireNonEmptyString(value.agentId, `${label} agentId`);
    requireTimestamp(value.issuedAtEpochMs, `${label} issuedAtEpochMs`);
    requireTimestamp(value.expiresAtEpochMs, `${label} expiresAtEpochMs`);
    if (value.issuedAtEpochMs >= value.expiresAtEpochMs) {
        throw new TypeError(`${label} lifecycle is invalid`);
    }
    return structuredClone(value) as
        & IssuedWebSocketTicket
        & Partial<Readonly<{ agentId: string }>>;
}

function decodeLegacyIssuedAuthSession(input: unknown): IssuedAuthSession {
    const value = requirePlainRecord(input, 'Legacy issued auth session');
    requireExactKeys(value, [
        'clientId',
        'username',
        'sessionId',
        'accessToken',
        'issuedAtEpochMs',
        'expiresAtEpochMs',
    ]);
    for (
        const field of [
            'clientId',
            'username',
            'sessionId',
            'accessToken',
        ] as const
    ) {
        requireNonEmptyString(value[field], `Legacy issued auth session ${field}`);
    }
    requireTimestamp(value.issuedAtEpochMs, 'Legacy issued auth session issuedAtEpochMs');
    requireTimestamp(value.expiresAtEpochMs, 'Legacy issued auth session expiresAtEpochMs');
    if (value.issuedAtEpochMs >= value.expiresAtEpochMs) {
        throw new TypeError('Legacy issued auth session lifecycle is invalid');
    }
    return structuredClone(value) as IssuedAuthSession;
}

async function toPersistedAuthSession(
    session: IssuedAuthSession,
): Promise<PersistedAuthSession> {
    return decodePersistedAuthSession({
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await hashAuthSecret(session.accessToken),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    });
}

function toIssuedAuthSession(
    session: PersistedAuthSession,
    accessToken: string,
): IssuedAuthSession {
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessToken,
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
}

function requirePlainRecord(
    input: unknown,
    label: string,
): Readonly<Record<string, unknown>> {
    if (
        typeof input !== 'object' || input === null || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    return input as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
    value: Readonly<Record<string, unknown>>,
    expectedKeys: readonly string[],
): void {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError('Persisted auth session fields are invalid');
    }
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is required`);
    }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${label} is invalid`);
    }
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
