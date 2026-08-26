import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryRead,
    type RuntimeStateEntryValue
} from '../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { hashAuthSecret } from '../credentials/hash-auth-secret.ts';
import type { IssuedAuthSession } from './auth-session-types.ts';
import {
    AUTH_SESSIONS_BY_SESSION_NAMESPACE,
    AUTH_SESSIONS_BY_TOKEN_NAMESPACE,
    authSessionKey,
    authTokenDigestKey
} from './auth-storage-keys.ts';
import { decodePersistedAuthSession, type PersistedAuthSession } from './persisted-auth-session.ts';

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
        const persisted = await this.findSessionByAccessTokenDigestEntry(await hashAuthSecret(accessToken));
        return persisted ? toIssuedAuthSession(persisted.value, accessToken) : undefined;
    }

    async findBySessionId(sessionId: string): Promise<PersistedAuthSession | undefined> {
        return (await this.findSessionBySessionIdEntry(sessionId))?.value;
    }

    async findSessionByAccessTokenEntry(
        accessToken: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        return await this.findSessionByAccessTokenDigestEntry(await hashAuthSecret(accessToken));
    }

    async findSessionByAccessTokenDigestEntry(
        accessTokenDigest: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthSession> | undefined> {
        return (await this.readSessionByAccessTokenDigestEntry(accessTokenDigest)).value;
    }

    async readSessionByAccessTokenDigestEntry(
        accessTokenDigest: string
    ): Promise<RuntimeStateEntryRead<PersistedAuthSession>> {
        const read = await this.getJsonEntryRead(
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
        const read = await this.getJsonEntryRead(
            AUTH_SESSIONS_BY_SESSION_NAMESPACE,
            authSessionKey(sessionId)
        );
        if (!read.value) {
            return { value: undefined, expiredEntry: read.expiredEntry };
        }
        const value = decodePersistedAuthSession(read.value.value);
        if (value.sessionId !== sessionId) {
            throw new TypeError('Persisted auth session id identity differs');
        }
        return { value: { entry: read.value.entry, value }, expiredEntry: undefined };
    }

    async deleteSession(session: IssuedAuthSession): Promise<void> {
        const accessTokenDigest = await hashAuthSecret(session.accessToken);
        await this.deleteValue(AUTH_SESSIONS_BY_TOKEN_NAMESPACE, authTokenDigestKey(accessTokenDigest));
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
