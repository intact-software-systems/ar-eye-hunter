import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

import type { ApiV1Sql } from './db.ts';

export function toPSqlSql(sqlClient: ApiV1Sql): PSqlSql {
    return sqlClient as PSqlSql;
}
