import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import { writeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type {
    AuthMutationComputed,
    AuthMutationResult,
    AuthPersistenceOperation
} from './auth-mutation-contracts.ts';

export async function writeAuthMutation(
    transaction: PSqlSql,
    computed: AuthMutationComputed
): Promise<AuthMutationResult> {
    for (const operation of computed.persistence.operations) {
        await writeAuthPersistenceOperation(transaction, operation);
    }
    if (computed.persistence.logoutOutbox) {
        await writeAppOutboxInsert(transaction, computed.persistence.logoutOutbox);
    }
    return computed.result;
}

async function writeAuthPersistenceOperation(
    transaction: PSqlSql,
    operation: AuthPersistenceOperation
): Promise<void> {
    switch (operation.kind) {
        case 'insert': {
            const rows = await transaction<Array<{ revision: number | string; }>>`
                insert into runtime_state_store (store_namespace, store_key, store_value,
                                                 expire_at_ts, updated_ts, revision)
                values (${operation.namespace}, ${operation.key}, ${operation.value},
                        ${operation.expireAtIsoTimestamp}, now(), 0)
                on conflict (store_namespace, store_key) do nothing
                returning revision
            `;
            requireApplied(rows);
            return;
        }
        case 'update': {
            const rows = await transaction<Array<{ revision: number | string; }>>`
                update runtime_state_store
                set store_value = ${operation.value},
                    expire_at_ts = ${operation.expireAtIsoTimestamp},
                    updated_ts = now(),
                    revision = revision + 1
                where store_namespace = ${operation.namespace}
                  and store_key = ${operation.key}
                  and revision = ${operation.expectedRevision}
                returning revision
            `;
            requireApplied(rows);
            return;
        }
        case 'delete': {
            const rows = await transaction<Array<{ revision: number | string; }>>`
                delete from runtime_state_store
                where store_namespace = ${operation.namespace}
                  and store_key = ${operation.key}
                  and revision = ${operation.expectedRevision}
                returning revision
            `;
            requireApplied(rows);
        }
    }
}

function requireApplied(rows: readonly Readonly<{ revision: number | string; }>[]): void {
    if (rows.length === 0) {
        throw new RuntimeStateWriteConflictError();
    }
}
