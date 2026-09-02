import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { computeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-mutation.ts';
import { validateTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/validate-topology-config-mutation.ts';
import { writeTopologyConfigMutation } from '@shared-server/rallar-system/topology/config/mutation/write-topology-config-mutation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { createPGliteSqlClient } from '../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createTopologyConfigMutationTestInput } from '../../rallar-system/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('topology config guarded writes', () => {
    it('stops on the first stale authority guard in the caller transaction without dependent writes or an inner retry', async () => {
        const sql = createPGliteSqlClient(new PGlite());
        let statements = 0;
        let nestedTransactionRequests = 0;

        try {
            await sql.exec(readFileSync(
                new URL('../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url),
                'utf8'
            ));
            const mutation = createTopologyConfigMutationTestInput();
            const computed = computeTopologyConfigMutation(mutation);
            validateTopologyConfigMutation({ ...mutation, computed });
            if (computed.outcome !== 'write') {
                throw new Error('Expected a topology config write');
            }
            const runtime = new PSqlRuntimeStateRepository(sql);
            const guard = mutation.read.groupAuthorityGuard.entry;
            await runtime.upsert('group-state:groups', guard.key, guard.value, guard.expireAtTimestamp);
            await runtime.upsert('group-state:groups', guard.key, guard.value, guard.expireAtTimestamp);
            expect(await runtime.findEntry('group-state:groups', guard.key)).toMatchObject({ revision: 1 });
            const before = await sql`select * from runtime_state_store`;

            await expect(sql.begin(async (transaction) => {
                const observed = new Proxy(transaction, {
                    apply(target, receiver, argumentsList) {
                        const stringsOrValues = argumentsList[0];
                        if (Array.isArray(stringsOrValues) && 'raw' in stringsOrValues) {
                            statements += 1;
                        }
                        return Reflect.apply(target, receiver, argumentsList);
                    },
                    get(target, key, receiver) {
                        if (key === 'begin') {
                            return async () => {
                                nestedTransactionRequests += 1;
                                throw new Error('The mutation cannot open a nested transaction');
                            };
                        }
                        return Reflect.get(target, key, receiver);
                    }
                });
                await writeTopologyConfigMutation({ transaction: observed, computed });
            })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

            expect(nestedTransactionRequests).toBe(0);
            expect(statements).toBe(1);
            expect(await sql`select * from runtime_state_store`).toEqual(before);
            expect(await sql`select * from resource_inbox`).toEqual([]);
        }
        finally {
            await sql.close();
        }
    });
});
