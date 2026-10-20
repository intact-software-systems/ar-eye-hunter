import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { PostgresSql } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

export interface GroupRowLock {
    /** Resolves once a writer of the group row waits on this lock, with that writer's backend pid. */
    waitForBlockedWriter(): Promise<number>;
    release(): Promise<void>;
}

export interface LockGroupRowInput {
    /** Holds its one connection in the locking transaction until release. */
    readonly lockSql: PostgresSql;
    /** Watches for the writer the lock blocks, on a connection of its own. */
    readonly observerSql: PSqlSql;
    readonly groupRef: GroupRef;
}

/**
 * Holds the group row's lock in a transaction of its own, so a command that writes the group row waits inside its
 * AppInbox transaction while a command that never touches it can commit.
 */
export async function lockGroupRow(input: LockGroupRowInput): Promise<GroupRowLock> {
    const locked = Promise.withResolvers<number>();
    const released = Promise.withResolvers<void>();
    const transaction = input.lockSql.begin(async (transactionSql) => {
        const [backend] = await transactionSql<{ pid: number; }[]>`
            select pg_backend_pid() as pid
            from runtime_state_store
            where store_namespace = ${GROUPS_NAMESPACE} and store_key = ${groupStateGroupStorageKey(input.groupRef)}
            for update
        `;
        if (!backend) {
            throw new Error('The group row to lock is missing');
        }
        locked.resolve(Number(backend.pid));
        await released.promise;
    });
    transaction.catch(locked.reject);
    const lockPid = await locked.promise;
    return {
        waitForBlockedWriter: async () => await waitForBlockedBackend(input.observerSql, lockPid),
        release: async () => {
            released.resolve();
            await transaction;
        }
    };
}

async function waitForBlockedBackend(sql: PSqlSql, lockPid: number): Promise<number> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const [blocked] = await sql<{ pid: number; }[]>`
            select pid from pg_stat_activity where ${lockPid} = any(pg_blocking_pids(pid))
        `;
        if (blocked) {
            return Number(blocked.pid);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('No writer ever waited on the group row lock');
}
