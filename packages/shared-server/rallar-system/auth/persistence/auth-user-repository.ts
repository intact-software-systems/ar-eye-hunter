import { RuntimeStateJsonStore } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { normalizeAuthUsername } from '../credentials/normalize-auth-username.ts';
import {
    AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
    AUTH_USERS_BY_USERNAME_NAMESPACE,
    authClientIdKey,
    authNormalizedUsernameKey
} from './auth-storage-keys.ts';
import { decodePersistedAuthUser, type PersistedAuthUser } from './persisted-auth-user.ts';

export class AuthUserRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putUser(user: PersistedAuthUser): Promise<void> {
        const persisted = decodePersistedAuthUser(user);
        await this.putValue(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            authNormalizedUsernameKey(persisted.normalizedUsername),
            persisted
        );
        await this.putValue(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            authClientIdKey(persisted.clientId),
            persisted
        );
    }

    async insertByNormalizedUsername(
        user: PersistedAuthUser
    ): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAuthUser(user);
        return await this.putValueIfAbsent(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            authNormalizedUsernameKey(persisted.normalizedUsername),
            persisted
        );
    }

    async insertByClientId(user: PersistedAuthUser): Promise<RuntimeStateConditionalWriteResult> {
        const persisted = decodePersistedAuthUser(user);
        return await this.putValueIfAbsent(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            authClientIdKey(persisted.clientId),
            persisted
        );
    }

    async findByUsername(username: string): Promise<PersistedAuthUser | undefined> {
        return await this.findByNormalizedUsername(normalizeAuthUsername(username));
    }

    async findByNormalizedUsername(normalizedUsername: string): Promise<PersistedAuthUser | undefined> {
        return (await this.findByNormalizedUsernameEntry(normalizedUsername))?.value;
    }

    async findByNormalizedUsernameEntry(
        normalizedUsername: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthUser> | undefined> {
        const stored = await this.getJsonEntryValue(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            authNormalizedUsernameKey(normalizedUsername)
        );
        if (!stored) {
            return undefined;
        }
        const value = decodePersistedAuthUser(stored.value);
        if (value.normalizedUsername !== normalizedUsername) {
            throw new TypeError('Persisted auth user normalized username identity differs');
        }
        return { entry: stored.entry, value };
    }

    async findByClientId(clientId: string): Promise<PersistedAuthUser | undefined> {
        return (await this.findByClientIdEntry(clientId))?.value;
    }

    async findByClientIdEntry(
        clientId: string
    ): Promise<RuntimeStateEntryValue<PersistedAuthUser> | undefined> {
        const stored = await this.getJsonEntryValue(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            authClientIdKey(clientId)
        );
        if (!stored) {
            return undefined;
        }
        const value = decodePersistedAuthUser(stored.value);
        if (value.clientId !== clientId) {
            throw new TypeError('Persisted auth user client id identity differs');
        }
        return { entry: stored.entry, value };
    }

    normalizedUsernameStorageKey(normalizedUsername: string): string {
        return authNormalizedUsernameKey(normalizedUsername);
    }

    normalizedUsernameNamespace(): string {
        return AUTH_USERS_BY_USERNAME_NAMESPACE;
    }
}
