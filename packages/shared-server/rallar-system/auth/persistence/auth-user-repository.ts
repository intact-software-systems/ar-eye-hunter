import { RuntimeStateJsonStore } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/RuntimeStateRepository.ts';

const AUTH_USERS_BY_USERNAME_NAMESPACE = 'auth-users:by-username';
const AUTH_USERS_BY_CLIENT_ID_NAMESPACE = 'auth-users:by-client-id';

export type AuthUserStatus = 'active' | 'disabled';

export type AuthUser = Readonly<{
    clientId: string;
    username: string;
    normalizedUsername: string;
    displayName: string | null;
    passwordHash: string;
    passwordSalt: string;
    passwordAlgorithm: 'pbkdf2-sha256';
    passwordIterations: number;
    roles: readonly string[];
    status: AuthUserStatus;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
}>;

export class AuthUserRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async putUser(user: AuthUser): Promise<void> {
        await this.putValue(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            this.normalizedUsernameKey(user.normalizedUsername),
            user
        );
        await this.putValue(AUTH_USERS_BY_CLIENT_ID_NAMESPACE, this.clientIdKey(user.clientId), user);
    }

    async insertByNormalizedUsername(user: AuthUser): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            this.normalizedUsernameKey(user.normalizedUsername),
            user
        );
    }

    async insertByClientId(user: AuthUser): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            this.clientIdKey(user.clientId),
            user
        );
    }

    async findByUsername(username: string): Promise<AuthUser | undefined> {
        return await this.findByNormalizedUsername(normalizeUsername(username));
    }

    async findByNormalizedUsername(normalizedUsername: string): Promise<AuthUser | undefined> {
        return await this.getValue<AuthUser>(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            this.normalizedUsernameKey(normalizedUsername)
        );
    }

    async findByNormalizedUsernameEntry(
        normalizedUsername: string
    ): Promise<RuntimeStateEntryValue<AuthUser> | undefined> {
        return await this.getEntryValue<AuthUser>(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            this.normalizedUsernameKey(normalizedUsername)
        );
    }

    async findByClientId(clientId: string): Promise<AuthUser | undefined> {
        return await this.getValue<AuthUser>(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            this.clientIdKey(clientId)
        );
    }

    async findByClientIdEntry(
        clientId: string
    ): Promise<RuntimeStateEntryValue<AuthUser> | undefined> {
        return await this.getEntryValue<AuthUser>(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            this.clientIdKey(clientId)
        );
    }

    normalizedUsernameStorageKey(normalizedUsername: string): string {
        return this.normalizedUsernameKey(normalizedUsername);
    }

    normalizedUsernameNamespace(): string {
        return AUTH_USERS_BY_USERNAME_NAMESPACE;
    }

    private normalizedUsernameKey(normalizedUsername: string): string {
        return this.idKey('username', normalizedUsername);
    }

    private clientIdKey(clientId: string): string {
        return this.idKey('client', clientId);
    }
}

export function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}
