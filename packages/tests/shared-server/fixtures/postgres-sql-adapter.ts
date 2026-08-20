import type postgres from 'postgres';

import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';

export function toPSqlSql(rawSql: postgres.Sql): PSqlSql {
  function sql<T>(
    strings: TemplateStringsArray,
    ...values: Parameters<PSqlSql>[0]
  ): Promise<T>;
  function sql(values: Parameters<PSqlSql>[0]): ReturnType<PSqlSql>;
  function sql(
    stringsOrValues: TemplateStringsArray | Parameters<PSqlSql>[0],
    ...values: Parameters<PSqlSql>[0]
  ) {
    return Reflect.apply(rawSql, rawSql, [stringsOrValues, ...values]);
  }
  sql.begin = async <T>(
    write: (transaction: PSqlTransactionSql) => Promise<T>,
  ): Promise<T> => {
    const result = await rawSql.begin(async (transaction) => ({
      value: await write(toPSqlTransactionSql(transaction)),
    }));
    return result.value;
  };
  return sql;
}

function toPSqlTransactionSql(rawSql: postgres.TransactionSql): PSqlTransactionSql {
  function sql<T>(
    strings: TemplateStringsArray,
    ...values: Parameters<PSqlTransactionSql>[0]
  ): Promise<T>;
  function sql(
    values: Parameters<PSqlTransactionSql>[0],
  ): ReturnType<PSqlTransactionSql>;
  function sql(
    stringsOrValues: TemplateStringsArray | Parameters<PSqlTransactionSql>[0],
    ...values: Parameters<PSqlTransactionSql>[0]
  ) {
    return Reflect.apply(rawSql, rawSql, [stringsOrValues, ...values]);
  }
  sql.begin = async <T>(
    write: (transaction: PSqlTransactionSql) => Promise<T>,
  ): Promise<T> => {
    const result = await rawSql.savepoint(async (transaction) => ({
      value: await write(toPSqlTransactionSql(transaction)),
    }));
    return result.value;
  };
  return sql;
}
