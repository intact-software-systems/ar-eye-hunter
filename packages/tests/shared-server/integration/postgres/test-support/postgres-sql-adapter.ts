import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

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

type SavepointPSqlSql =
    & PSqlSql
    & Readonly<{
        savepoint<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
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
        write: (transaction: PSqlSql) => Promise<T>
    ): Promise<T> => {
        const result = await rawSql.begin(async (transaction) => ({
            value: await write(toSavepointPSqlSql(transaction))
        }));
        return result.value;
    };
    return sql;
}

function toSavepointPSqlSql(
    rawSql: PostgresTransactionSqlAdapterSource
): SavepointPSqlSql {
    function sql<T>(
        strings: TemplateStringsArray,
        ...values: Parameters<PSqlSql>[0]
    ): Promise<T>;
    function sql(
        values: Parameters<PSqlSql>[0]
    ): ReturnType<PSqlSql>;
    function sql(
        stringsOrValues: TemplateStringsArray | Parameters<PSqlSql>[0],
        ...values: Parameters<PSqlSql>[0]
    ) {
        return Reflect.apply(rawSql, rawSql, [stringsOrValues, ...values]);
    }
    const savepoint = async <T>(
        write: (transaction: PSqlSql) => Promise<T>
    ): Promise<T> => {
        const result = await rawSql.savepoint(async (transaction) => ({
            value: await write(toSavepointPSqlSql(transaction))
        }));
        return result.value;
    };
    sql.begin = savepoint;
    sql.savepoint = savepoint;
    return sql;
}
