import { normalizeAuthUsername } from '../auth/credentials/normalize-auth-username.ts';
import type { AuthUserRepository } from '../auth/persistence/auth-user-repository.ts';

export interface FriendsAccount {
    readonly principalId: string;
    readonly username: string;
    readonly displayName: string;
}

export class FriendsAccountDirectory {
    private readonly users: Pick<AuthUserRepository, 'findByUsername' | 'findByClientId'>;
    private readonly configuredAccounts: readonly FriendsAccount[];

    constructor(
        users: Pick<AuthUserRepository, 'findByUsername' | 'findByClientId'>,
        configuredAccounts: readonly FriendsAccount[]
    ) {
        this.users = users;
        this.configuredAccounts = configuredAccounts;
    }

    async readByUsername(username: string): Promise<FriendsAccount | null> {
        const user = await this.users.findByUsername(username);
        if (user !== undefined) {
            return user.status === 'active'
                ? {
                    principalId: user.clientId,
                    username: user.username,
                    displayName: user.displayName ?? user.username
                }
                : null;
        }
        const normalized = normalizeAuthUsername(username);
        return this.configuredAccounts.find((account) => normalizeAuthUsername(account.username) === normalized) ??
            null;
    }

    async readByPrincipalId(principalId: string): Promise<FriendsAccount | null> {
        const user = await this.users.findByClientId(principalId);
        if (user !== undefined) {
            return user.status === 'active'
                ? {
                    principalId: user.clientId,
                    username: user.username,
                    displayName: user.displayName ?? user.username
                }
                : null;
        }
        return this.configuredAccounts.find((account) => account.principalId === principalId) ?? null;
    }
}
