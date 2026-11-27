import type { PSqlParameter, PSqlQuery, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

/** The callable part of a SQL port: a template statement and a values fragment. */
export interface PostgresSqlCall extends PSqlQuery {
    (values: readonly PSqlParameter[]): object;
}

/**
 * The callable part of a SQL port that wraps `source`: a template statement runs through `query`, a values fragment
 * (`sql([...])`) goes to `source` unchanged. The caller adds `begin` and whichever optional members it forwards.
 */
export function createPostgresSqlCall(source: PSqlSql, query: PSqlQuery): PostgresSqlCall {
    function call<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function call(values: readonly PSqlParameter[]): object;
    function call<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        return Object.hasOwn(stringsOrValues, 'raw')
            ? query<Result>(stringsOrValues as TemplateStringsArray, ...values)
            : source(stringsOrValues as readonly PSqlParameter[]);
    }
    return call;
}
