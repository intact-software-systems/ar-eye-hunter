import { PSqlFragment } from '@shared-server/postgres/p-sql-fragment.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

interface PostgresSqlAdapterSource {
    (...arguments_: never[]): object;
    unsafe(...arguments_: never[]): object;
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
        return startStatement(rawSql, stringsOrValues, values, startUnpreparedStatement);
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
        return startStatement(rawSql, stringsOrValues, values, startCustomPlannedStatement);
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

const FORCE_CUSTOM_PLAN = PSqlFragment.of`set local plan_cache_mode = force_custom_plan`.toStatement();
const DEFAULT_PLAN_CACHE_MODE = PSqlFragment.of`set local plan_cache_mode = default`.toStatement();

/** A statement planned per execution, as its template call and as its positional text. */
interface PlannedStatement {
    readonly strings: TemplateStringsArray;
    readonly text: string;
    readonly values: Parameters<PSqlSql>[0];
}

type PlannedStatementStart = (rawSql: PostgresSqlAdapterSource, statement: PlannedStatement) => object;

/** As the API's adapter does: a statement planned per execution starts as its handle sends one. */
function startStatement(
    rawSql: PostgresSqlAdapterSource,
    stringsOrValues: TemplateStringsArray | Parameters<PSqlSql>[0],
    values: Parameters<PSqlSql>[0],
    startPlannedStatement: PlannedStatementStart
): object {
    const text = Object.hasOwn(stringsOrValues, 'raw')
        ? PSqlFragment.getPlannedPerExecutionText(stringsOrValues as TemplateStringsArray)
        : undefined;
    return text === undefined
        ? Reflect.apply(rawSql, rawSql, [stringsOrValues, ...values])
        : startPlannedStatement(rawSql, { strings: stringsOrValues as TemplateStringsArray, text, values });
}

/** At the root: unprepared, as its positional text. */
function startUnpreparedStatement(rawSql: PostgresSqlAdapterSource, { text, values }: PlannedStatement): object {
    PSqlFragment.assertPositionalParameters(values);
    return Reflect.apply(rawSql.unsafe, rawSql, [text, values, { prepare: false }]);
}

/** In a transaction: between two transaction-scoped plan-cache settings, issued together into one pipelined write. */
async function startCustomPlannedStatement(
    rawSql: PostgresSqlAdapterSource,
    { strings, values }: PlannedStatement
): Promise<object> {
    const [, result] = await Promise.all([
        Reflect.apply(rawSql, rawSql, FORCE_CUSTOM_PLAN),
        Reflect.apply(rawSql, rawSql, [strings, ...values]),
        Reflect.apply(rawSql, rawSql, DEFAULT_PLAN_CACHE_MODE)
    ]);
    return result;
}
