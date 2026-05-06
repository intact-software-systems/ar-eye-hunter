import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';

const AUTH_USERS_BY_USERNAME_NAMESPACE = 'auth-users:by-username';
const AUTH_USERS_BY_CLIENT_ID_NAMESPACE = 'auth-users:by-client-id';

export type AuthUserStatus = 'active' | 'disabled';

export type AuthUser = Readonly<{
    clientId: string;
    username: string;
    normalizedUsername: string;
    displayName?: string;
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
            user,
        );
        await this.putValue(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            this.clientIdKey(user.clientId),
            user,
        );
    }

    async findByUsername(username: string): Promise<AuthUser | undefined> {
        return await this.findByNormalizedUsername(normalizeUsername(username));
    }

    async findByNormalizedUsername(normalizedUsername: string): Promise<AuthUser | undefined> {
        return await this.getValue<AuthUser>(
            AUTH_USERS_BY_USERNAME_NAMESPACE,
            this.normalizedUsernameKey(normalizedUsername),
        );
    }

    async findByClientId(clientId: string): Promise<AuthUser | undefined> {
        return await this.getValue<AuthUser>(
            AUTH_USERS_BY_CLIENT_ID_NAMESPACE,
            this.clientIdKey(clientId),
        );
    }

    usernameLockKey(normalizedUsername: string): string {
        return this.normalizedUsernameKey(normalizedUsername);
    }

    usernameLockNamespace(): string {
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
