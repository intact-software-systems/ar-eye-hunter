import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';

interface PostgresSqlAdapterSource {
    (...arguments_: never[]): object;
}

interface PostgresRootSqlAdapterSource extends PostgresSqlAdapterSource {
    begin<T>(
        write: (
            transaction: PostgresTransactionSqlAdapterSource
        ) => Promise<Readonly<{ value: T; }>>
    ): Promise<Readonly<{ value: T; }>>;
}

interface PostgresTransactionSqlAdapterSource extends PostgresSqlAdapterSource {
    savepoint<T>(
        write: (
            transaction: PostgresTransactionSqlAdapterSource
        ) => Promise<Readonly<{ value: T; }>>
    ): Promise<Readonly<{ value: T; }>>;
}

type SavepointPSqlTransactionSql =
    & PSqlTransactionSql
    & Readonly<{
        savepoint<T>(write: (transaction: PSqlTransactionSql) => Promise<T>): Promise<T>;
    }>;

export function toPSqlSql(rawSql: PostgresRootSqlAdapterSource): PSqlSql {
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
        write: (transaction: PSqlTransactionSql) => Promise<T>
    ): Promise<T> => {
        const result = await rawSql.begin(async (transaction) => ({
            value: await write(toPSqlTransactionSql(transaction))
        }));
        return result.value;
    };
    return sql;
}

function toPSqlTransactionSql(
    rawSql: PostgresTransactionSqlAdapterSource
): SavepointPSqlTransactionSql {
    function sql<T>(
        strings: TemplateStringsArray,
        ...values: Parameters<PSqlTransactionSql>[0]
    ): Promise<T>;
    function sql(
        values: Parameters<PSqlTransactionSql>[0]
    ): ReturnType<PSqlTransactionSql>;
    function sql(
        stringsOrValues: TemplateStringsArray | Parameters<PSqlTransactionSql>[0],
        ...values: Parameters<PSqlTransactionSql>[0]
    ) {
        return Reflect.apply(rawSql, rawSql, [stringsOrValues, ...values]);
    }
    const savepoint = async <T>(
        write: (transaction: PSqlTransactionSql) => Promise<T>
    ): Promise<T> => {
        const result = await rawSql.savepoint(async (transaction) => ({
            value: await write(toPSqlTransactionSql(transaction))
        }));
        return result.value;
    };
    sql.begin = savepoint;
    sql.savepoint = savepoint;
    return sql;
}
