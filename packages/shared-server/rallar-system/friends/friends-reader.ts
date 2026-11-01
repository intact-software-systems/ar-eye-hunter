import type { FriendsView } from '@shared/api/friends/friends-view.ts';
import type { FriendContact } from '@shared/api/friends/friendship.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import type { ClientStateService } from '../client-state/client-state-service-contracts.ts';
import type { FriendsAccountDirectory } from './friends-account-directory.ts';
import type { FriendsRepository } from './friends-repository.ts';
import { toFriendsView, type FriendsPeerRead } from './to-friends-view.ts';

export namespace FriendsReader {
    export interface Dependencies {
        readonly profiles: FriendsRepository;
        readonly accounts: FriendsAccountDirectory;
        readonly clients: Pick<ClientStateService, 'readSnapshot'>;
        readonly nowEpochMs: () => number;
    }

    export interface PeerInput {
        readonly principalId: string;
        readonly scope: StateScope;
        readonly contact: FriendContact;
    }
}

export class FriendsReader {
    private readonly dependencies: FriendsReader.Dependencies;

    constructor(dependencies: FriendsReader.Dependencies) {
        this.dependencies = dependencies;
    }

    async read(principalId: string, scope: StateScope): Promise<FriendsView> {
        const { profile } = await this.dependencies.profiles.readProfile(principalId);
        const peers = await Promise.all(
            profile.contacts.map((contact) => this.readPeer({ principalId, scope, contact }))
        );
        return toFriendsView({ profile, peers, nowEpochMs: this.dependencies.nowEpochMs() });
    }

    private async readPeer({ principalId, scope, contact }: FriendsReader.PeerInput): Promise<FriendsPeerRead> {
        const { profiles, accounts, clients, nowEpochMs } = this.dependencies;
        const account = await accounts.readByPrincipalId(contact.principalId);
        const profile = contact.status === 'friend' ? (await profiles.readProfile(contact.principalId)).profile : null;
        const shared = account !== null && profile?.shareOnline === true &&
            profile.contacts.some((other) => other.principalId === principalId && other.status === 'friend');
        const snapshot = shared
            ? await clients.readSnapshot({ ...scope, principalId: contact.principalId })
            : undefined;
        const now = nowEpochMs();
        return {
            account: account ??
                { principalId: contact.principalId, username: contact.principalId, displayName: contact.principalId },
            profile,
            online:
                snapshot?.activeSessions.some((session) =>
                    session.status === 'active' && session.expiresAtEpochMs > now
                ) === true
        };
    }
}
