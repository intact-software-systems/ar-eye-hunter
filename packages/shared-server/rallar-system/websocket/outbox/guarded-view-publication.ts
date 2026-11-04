import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import {
    computeRuntimeStateConditionalWrite,
    type RuntimeStateConditionalWrite
} from '../../../runtime-state/compute-runtime-state-conditional-write.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { writeRuntimeStateConditionalBatch } from '../../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { writeRuntimeStateConditional } from '../../../runtime-state/postgres/write-runtime-state-conditional.ts';
import { writeAppOutboxInserts, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';

/** Complete conditional guards and outbox writes prepared by a view's domain owner. */
export interface GuardedViewPublication {
    readonly storage: RuntimeStateGuardedBatchWrite | RuntimeStateConditionalWrite;
    readonly outbox: readonly AppOutboxInsert[];
}

/** A guard without effects is one conditional row, not an invalid empty guarded batch. */
export function computeGuardedViewPublication(
    storage: RuntimeStateGuardedBatch,
    outbox: readonly AppOutboxInsert[]
): GuardedViewPublication {
    if (storage.guard.operation !== 'insert' && storage.guard.operation !== 'update') {
        throw new TypeError('View publication requires an insert or revision-update observation guard');
    }
    return {
        storage: storage.effects.length === 0
            ? computeRuntimeStateConditionalWrite(storage.guard)
            : computeRuntimeStateGuardedBatchWrite(storage),
        outbox
    };
}

/** Runs inside the client mutation's transaction, after its principal CAS (and the WS ticket/generation guard). */
export async function writeGuardedViewPublication(
    transaction: PSqlSql,
    publication: GuardedViewPublication | null
): Promise<void> {
    if (publication === null) {
        return;
    }
    await writeGuardedViewPublicationStorage(transaction, publication.storage);
    await writeAppOutboxInserts(transaction, publication.outbox);
}

/** Storage-only write for an owner that bulk-inserts all of its already prepared outbox rows together. */
export async function writeGuardedViewPublicationStorage(
    transaction: PSqlSql,
    storage: GuardedViewPublication['storage']
): Promise<void> {
    if ('operation' in storage) {
        const result = await writeRuntimeStateConditional(transaction, storage);
        if (result.status !== 'applied') {
            throw new RuntimeStateWriteConflictError();
        }
    }
    else {
        await writeRuntimeStateConditionalBatch(transaction, { creation: null, inserts: [], batch: storage });
    }
}

/** Atomic view publications can share consent or membership predecessors; guard each exact observation once in the same transaction. */
export function combineGuardedViewPublications(
    publications: readonly (GuardedViewPublication | null)[]
): GuardedViewPublication | null {
    const rows = new Map<string, RuntimeStateGuardedBatchGuard>();
    const outbox: AppOutboxInsert[] = [];
    for (const publication of publications) {
        if (publication === null) {
            continue;
        }
        const writes = 'operation' in publication.storage
            ? [publication.storage]
            : [publication.storage.guard, ...publication.storage.effects];
        for (const row of writes) {
            if (row.operation !== 'insert' && row.operation !== 'update') {
                throw new TypeError('View publication has an unexpected persistence operation');
            }
            const canonical: RuntimeStateGuardedBatchGuard = row.operation === 'insert'
                ? {
                    operation: 'insert',
                    namespace: row.namespace,
                    key: row.key,
                    value: row.value,
                    expireAtTimestamp: row.expireAtTimestamp
                }
                : {
                    operation: 'update',
                    namespace: row.namespace,
                    key: row.key,
                    value: row.value,
                    expireAtTimestamp: row.expireAtTimestamp,
                    expectedRevision: row.expectedRevision
                };
            const identity = JSON.stringify([row.namespace, row.key]);
            const previous = rows.get(identity);
            if (previous !== undefined && !jsonEquals(previous, canonical)) {
                throw new RuntimeStateWriteConflictError();
            }
            rows.set(identity, canonical);
        }
        outbox.push(...publication.outbox);
    }
    const [guard, ...remaining] = rows.values();
    if (guard === undefined) {
        return null;
    }
    const effects: RuntimeStateGuardedBatchEffect[] = remaining.map((row, index) => ({
        ...row,
        effectId: `view-publication:${index}`
    }));
    return computeGuardedViewPublication({ guard, effects }, outbox);
}
