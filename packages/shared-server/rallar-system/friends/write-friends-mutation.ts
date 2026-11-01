import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { FriendsMutationComputed } from './friends-mutation-contracts.ts';
import { writeFriendsProfiles } from './friends-repository.ts';

export async function writeFriendsMutation(transaction: PSqlSql, computed: FriendsMutationComputed): Promise<void> {
    if (computed.result.status === 'refused') {
        return;
    }
    const repository = createTransactionBoundPSqlRuntimeStateRepository(transaction);
    for (const guard of computed.guards) {
        const written = await repository.upsertIfRevision(
            guard.namespace,
            guard.key,
            guard.value,
            guard.expireAtTimestamp,
            guard.expectedRevision
        );
        if (written.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
    }
    await writeFriendsProfiles(transaction, computed.writes);
}
