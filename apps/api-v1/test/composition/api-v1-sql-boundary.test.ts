import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

import type { ApiV1Sql } from '../../src/db/db.ts';
import { toPSqlSql } from '../../src/db/api-v1-sql-boundary.ts';

Deno.test('toPSqlSql preserves the supported API SQL client identity', () => {
  const database = Object.assign(
    function <T>(_strings: TemplateStringsArray, ..._values: unknown[]): Promise<T> {
      return Promise.reject(new Error('query not used'));
    },
    {
      begin<T>(_operation: (transaction: PSqlSql) => Promise<T>): Promise<T> {
        return Promise.reject(new Error('transaction not used'));
      },
    },
  ) as PSqlSql;
  const sqlClient: ApiV1Sql = database;

  assert.equal(toPSqlSql(sqlClient), database);
});
