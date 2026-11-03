import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateEntry } from '../../runtime-state/runtime-state-repository.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import type { FriendsProfileRead } from './friends-mutation-contracts.ts';
import { decodeFriendsProfile, FRIENDS_PROFILE_NAMESPACE, friendsProfileKey } from './friends-profile.ts';

export class FriendsRepository {
    private readonly repository: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>;

    constructor(repository: Pick<RuntimeStateRepositoryLike, 'readRuntimeStateBatch'>) {
        this.repository = repository;
    }

    async readProfile(principalId: string): Promise<FriendsProfileRead> {
        return (await this.readProfiles([principalId]))[0]!;
    }

    /** One SQL snapshot keeps mirrored consent coherent while another transaction changes both accounts. */
    async readProfiles(principalIds: readonly string[]): Promise<readonly FriendsProfileRead[]> {
        const selectors = [...new Set(principalIds)].map((principalId) => ({
            selectorId: friendsProfileKey(principalId),
            kind: 'key' as const,
            namespace: FRIENDS_PROFILE_NAMESPACE,
            key: friendsProfileKey(principalId)
        }));
        const batch = await this.repository.readRuntimeStateBatch(selectors);
        if (
            batch.length !== selectors.length ||
            new Set(batch.map((selection) => selection.selectorId)).size !== batch.length
        ) {
            throw new Error('Friends profile batch identities are invalid');
        }
        return principalIds.map((principalId) => {
            const selection = batch.find((candidate) => candidate.selectorId === friendsProfileKey(principalId));
            if (selection === undefined || selection.entries.length > 1) {
                throw new Error('Friends profile batch slot is invalid');
            }
            return decodeStoredFriendsProfile(principalId, selection.entries[0]);
        });
    }
}

function decodeStoredFriendsProfile(principalId: string, entry: RuntimeStateEntry | undefined): FriendsProfileRead {
    if (entry === undefined) {
        return { entry: null, profile: { principalId, shareOnline: false, contacts: [], invitations: [] } };
    }
    if (entry.key !== friendsProfileKey(principalId) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new Error('Friends profile storage identity or lifetime differs');
    }
    try {
        return { entry, profile: decodeFriendsProfile(JSON.parse(entry.value), principalId) };
    }
    catch (cause) {
        throw new Error('Friends profile stored identity or content is invalid', { cause });
    }
}
