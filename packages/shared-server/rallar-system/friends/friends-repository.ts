import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import type { FriendsProfileRead, FriendsProfileWrite } from './friends-mutation-contracts.ts';
import { decodeFriendsProfile, FRIENDS_PROFILE_NAMESPACE, friendsProfileKey } from './friends-profile.ts';

export class FriendsRepository {
    private readonly repository: Pick<RuntimeStateRepositoryLike, 'findEntry'>;

    constructor(repository: Pick<RuntimeStateRepositoryLike, 'findEntry'>) {
        this.repository = repository;
    }

    async readProfile(principalId: string): Promise<FriendsProfileRead> {
        const key = friendsProfileKey(principalId);
        const entry = await this.repository.findEntry(FRIENDS_PROFILE_NAMESPACE, key);
        if (entry === undefined) {
            return { entry: null, profile: { principalId, shareOnline: false, contacts: [], invitations: [] } };
        }
        if (entry.key !== key) {
            throw new TypeError('Friends profile storage identity differs');
        }
        return { entry, profile: decodeFriendsProfile(JSON.parse(entry.value), principalId) };
    }
}

export async function writeFriendsProfiles(
    transaction: PSqlSql,
    writes: readonly FriendsProfileWrite[]
): Promise<void> {
    const repository = createTransactionBoundPSqlRuntimeStateRepository(transaction);
    for (const write of writes) {
        const result = write.expectedRevision === null
            ? await repository.insertIfAbsent(
                FRIENDS_PROFILE_NAMESPACE,
                write.key,
                write.value,
                write.expireAtTimestamp
            )
            : await repository.upsertIfRevision(
                FRIENDS_PROFILE_NAMESPACE,
                write.key,
                write.value,
                write.expireAtTimestamp,
                write.expectedRevision
            );
        if (result.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
    }
}
