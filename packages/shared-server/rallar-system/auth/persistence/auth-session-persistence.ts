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
import { isLegacyPlaintextCompatibilityActive, readBoundedLegacyAuthPage } from './auth-legacy-compatibility.ts';
import { decodePersistedAuthSession, type PersistedAuthSession } from './auth-persistence-contracts.ts';
import type { IssuedAuthSession } from './auth-session-types.ts';
import {
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
    authLegacyTokenKey,
    authSessionKey,
    authTokenDigestKey
} from './auth-storage-keys.ts';

export class AuthSessionPersistence extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putSession(session: IssuedAuthSession): Promise<void> {
        const persisted = await toPersistedAuthSession(session);
        await this.putValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            authTokenDigestKey(persisted.accessTokenDigest),
            persisted,
            session.expiresAtEpochMs
        );
        await this.putValue(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            authSessionKey(session.sessionId),
            persisted,
            session.expiresAtEpochMs
        );
    }

    async insertSessionByToken(
        session: IssuedAuthSession
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.insertSessionByTokenDigest(await toPersistedAuthSession(session));
    }

    async insertSessionByTokenDigest(
        session: PersistedAuthSession,
        expectedRevision: number | null = null
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAuthSession(session);
        return expectedRevision === null
            ? await this.putValueIfAbsent(
                AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
                authTokenDigestKey(persisted.accessTokenDigest),
                persisted,
                persisted.expiresAtEpochMs
            )
            : await this.putValueIfRevision(
                AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
                authTokenDigestKey(persisted.accessTokenDigest),
                persisted,
                persisted.expiresAtEpochMs,
                expectedRevision
            );
    }

    async insertSessionBySessionId(
        session: PersistedAuthSession,
        expectedRevision: number | null = null
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAuthSession(session);
        return expectedRevision === null
            ? await this.putValueIfAbsent(
                AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                authSessionKey(persisted.sessionId),
                persisted,
                persisted.expiresAtEpochMs
            )
            : await this.putValueIfRevision(
                AUTH_SESSIONS_BY_SESSION_NAMESPACE,
                authSessionKey(persisted.sessionId),
                persisted,
                persisted.expiresAtEpochMs,
                expectedRevision
            );
    }

    async findByAccessToken(accessToken: string): Promise<IssuedAuthSession | undefined> {
        const persisted = (await this.findSessionByAccessTokenDigestEntry(await hashAuthSecret(accessToken))) ??
            (await this.findLegacySessionByAccessTokenEntry(accessToken));
        return persisted ? toIssuedAuthSession(persisted.value, accessToken) : undefined;
    }

    async findBySessionId(sessionId: string): Promise<PersistedAuthSession | undefined> {
        return (await this.findSessionBySessionIdEntry(sessionId))?.value;
    }

    async findSessionByAccessTokenEntry(
        accessToken: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        return (
            (await this.findSessionByAccessTokenDigestEntry(await hashAuthSecret(accessToken))) ??
                (await this.findLegacySessionByAccessTokenEntry(accessToken))
        );
    }

    async findLegacySessionByAccessTokenEntry(
        accessToken: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        if (!isLegacyPlaintextCompatibilityActive()) {
            return undefined;
        }
        const entry = await this.getEntryValue<unknown>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            authLegacyTokenKey(accessToken)
        );
        if (!entry) {
            return undefined;
        }
        const legacy = decodeLegacyIssuedAuthSession(entry.value);
        if (legacy.accessToken !== accessToken) {
            throw new TypeError('Legacy auth session token identity differs');
        }
        return { entry: entry.entry, value: await toPersistedAuthSession(legacy) };
    }

    async findLegacySessionByAccessTokenDigestEntry(
        accessTokenDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        for (
            const entry of await readBoundedLegacyAuthPage(
                this.repository,
                AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
                authLegacyTokenKey('')
            )
        ) {
            const live = await this.toLiveEntryValue<unknown>(AUTH_SESSIONS_BY_TOKEN_NAMESPACE, entry);
            if (!live) {
                continue;
            }
            const legacy = decodeLegacyIssuedAuthSession(live.value);
            if (live.entry.key !== authLegacyTokenKey(legacy.accessToken)) {
                continue;
            }
            if ((await hashAuthSecret(legacy.accessToken)) !== accessTokenDigest) {
                continue;
            }
            return {
                entry: live.entry,
                value: await toPersistedAuthSession(legacy)
            };
        }
        return undefined;
    }

    async findSessionByAccessTokenDigestEntry(
        accessTokenDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        return (await this.readSessionByAccessTokenDigestEntry(accessTokenDigest)).value;
    }

    async readSessionByAccessTokenDigestEntry(
        accessTokenDigest: string
    ): Promise<RuntimeStateEntryRead<PersistedAuthSession>> {
        const read = await this.getEntryRead<unknown>(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            authTokenDigestKey(accessTokenDigest)
        );
        if (!read.value) {
            return { value: undefined, expiredEntry: read.expiredEntry };
        }
        const value = decodePersistedAuthSession(read.value.value);
        if (value.accessTokenDigest !== accessTokenDigest) {
            throw new TypeError('Persisted auth session token digest identity differs');
        }
        return { value: { entry: read.value.entry, value }, expiredEntry: undefined };
    }

    async findSessionBySessionIdEntry(
        sessionId: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        return (await this.readSessionBySessionIdEntry(sessionId)).value;
    }

    async readSessionBySessionIdEntry(
        sessionId: string
    ): Promise<RuntimeStateEntryRead<PersistedAuthSession>> {
        const read = await this.getEntryRead<unknown>(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            authSessionKey(sessionId)
        );
        if (!read.value) {
            return { value: undefined, expiredEntry: read.expiredEntry };
        }
        const value = await decodePersistedOrLegacyAuthSession(read.value.value);
        if (!value) {
            return { value: undefined, expiredEntry: undefined };
        }
        if (value.sessionId !== sessionId) {
            throw new TypeError('Persisted auth session id identity differs');
        }
        return { value: { entry: read.value.entry, value }, expiredEntry: undefined };
    }

    async deleteSession(session: IssuedAuthSession): Promise<void> {
        const accessTokenDigest = await hashAuthSecret(session.accessToken);
        await this.deleteValue(AUTH_SESSIONS_BY_TOKEN_NAMESPACE, authTokenDigestKey(accessTokenDigest));
        await this.deleteValue(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            authLegacyTokenKey(session.accessToken)
        );
        await this.deleteValue(AUTH_SESSIONS_BY_SESSION_NAMESPACE, authSessionKey(session.sessionId));
    }

    async deleteSessionBySessionIdIfRevision(
        sessionId: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            authSessionKey(sessionId),
            expectedRevision
        );
    }

    async deleteSessionByAccessTokenDigestIfRevision(
        accessTokenDigest: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            authTokenDigestKey(accessTokenDigest),
            expectedRevision
        );
    }

    async deleteLegacySessionByAccessTokenIfRevision(
        accessToken: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            authLegacyTokenKey(accessToken),
            expectedRevision
        );
    }

    async deleteSessionTokenStorageKeyIfRevision(
        storageKey: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
            storageKey,
            expectedRevision
        );
    }
}

async function decodePersistedOrLegacyAuthSession(
    input: unknown
): Promise<PersistedAuthSession | undefined> {
    try {
        return decodePersistedAuthSession(input);
    }
    catch (persistedError) {
        let legacy: IssuedAuthSession;
        try {
            legacy = decodeLegacyIssuedAuthSession(input);
        }
        catch {
            throw persistedError;
        }
        if (!isLegacyPlaintextCompatibilityActive()) {
            return undefined;
        }
        return await toPersistedAuthSession(legacy);
    }
}

function decodeLegacyIssuedAuthSession(input: unknown): IssuedAuthSession {
    const value = requirePlainRecord(input, 'Legacy issued auth session');
    requireExactKeys(value, [
        'clientId',
        'username',
        'sessionId',
        'accessToken',
        'issuedAtEpochMs',
        'expiresAtEpochMs'
    ]);
    for (const field of ['clientId', 'username', 'sessionId', 'accessToken'] as const) {
        requireNonEmptyString(value[field], `Legacy issued auth session ${field}`);
    }
    requireTimestamp(value.issuedAtEpochMs, 'Legacy issued auth session issuedAtEpochMs');
    requireTimestamp(value.expiresAtEpochMs, 'Legacy issued auth session expiresAtEpochMs');
    if (value.issuedAtEpochMs >= value.expiresAtEpochMs) {
        throw new TypeError('Legacy issued auth session lifecycle is invalid');
    }
    return structuredClone(value) as IssuedAuthSession;
}

async function toPersistedAuthSession(session: IssuedAuthSession): Promise<PersistedAuthSession> {
    return decodePersistedAuthSession({
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await hashAuthSecret(session.accessToken),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs
    });
}

function toIssuedAuthSession(
    session: PersistedAuthSession,
    accessToken: string
): IssuedAuthSession {
    return { ...session, accessToken };
}

function requirePlainRecord(input: unknown, label: string): Readonly<Record<string, unknown>> {
    if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype
    ) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    return input as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
    value: Readonly<Record<string, unknown>>,
    expectedKeys: readonly string[]
): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expectedKeys].sort())) {
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
