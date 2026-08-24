import assert from 'node:assert/strict';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { createApiV1MutationRuntime } from '../../src/composition/create-api-v1-mutation-runtime.ts';
import { toResilienceDto } from '../api-v1-test-queue-resilience.ts';

Deno.test('mutation runtime keeps one database identity and performs no construction query', () => {
    const databaseProbe = createDatabaseProbe();
    const mutation = createApiV1MutationRuntime({
        database: databaseProbe.database,
        serviceId: 'api-test',
        authCredentialSecret: 'a'.repeat(32),
        nowEpochMs: () => 1_000,
        timing: () => {},
        appInboxOptions: { nowEpochMs: () => 1_000 },
        groupCapacity: { defaultMaxMembers: 10 },
        groupFormationRecomputeDebounceMs: 250,
        adminClientIds: ['admin-1'],
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: {
            inbox: toResilienceDto(),
            outbox: toResilienceDto(),
            appOutbox: toResilienceDto()
        }
    });

    assert.equal(mutation.runtimeStateRepository.sql, databaseProbe.database);
    assert.equal(mutation.queueBox.resourceInbox, mutation.resourceInboxRepository);
    assert.equal(databaseProbe.queryCount(), 0);
    assert.equal(databaseProbe.transactionCount(), 0);
});

interface DatabaseProbe {
    readonly database: PSqlSql;
    queryCount(): number;
    transactionCount(): number;
}

function createDatabaseProbe(): DatabaseProbe {
    let queries = 0;
    let transactions = 0;
    function query<T>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<T>;
    function query(_values: readonly PSqlParameter[]): object;
    function query(
        _input: TemplateStringsArray | readonly PSqlParameter[],
        ..._values: readonly PSqlParameter[]
    ): never {
        queries += 1;
        throw new Error('query not expected');
    }
    const database: PSqlSql = Object.assign(
        query,
        {
            begin<T>(_operation: (transaction: PSqlSql) => Promise<T>): Promise<T> {
                transactions += 1;
                return Promise.reject(new Error('transaction not expected'));
            }
        }
    );

    return {
        database,
        queryCount: () => queries,
        transactionCount: () => transactions
    };
}
