import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

export interface RecordedPostgresStatement {
    /** The recorded transaction the statement ran in, numbered from one; `null` for an autocommit statement. */
    readonly transaction: number | null;
    readonly text: string;
    readonly values: readonly PSqlParameter[];
    readonly rowCount: number;
}

export interface PostgresStatementLog {
    readonly statements: RecordedPostgresStatement[];
    transactions: number;
}

/** Records every template statement with its values, its row count and the transaction it ran in, as it answers. */
export function recordPostgresStatements(
    source: PSqlSql,
    log: PostgresStatementLog,
    transaction: number | null
): PSqlSql {
    function recording<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function recording(values: readonly PSqlParameter[]): object;
    function recording<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        const strings = stringsOrValues as TemplateStringsArray;
        const text = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
        return source<Result>(strings, ...values).then((rows) => {
            log.statements.push({ transaction, text, values, rowCount: Array.isArray(rows) ? rows.length : 0 });
            return rows;
        });
    }
    const savepoint = (source as Partial<{ savepoint: PSqlSql['begin']; }>).savepoint;
    return Object.assign(recording, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            log.transactions += 1;
            const opened = log.transactions;
            return await source.begin(async (inner) => await write(recordPostgresStatements(inner, log, opened)));
        },
        ...(savepoint === undefined ? {} : {
            savepoint: async <T>(write: (inner: PSqlSql) => Promise<T>): Promise<T> =>
                await savepoint.call(
                    source,
                    async (inner: PSqlSql) => await write(recordPostgresStatements(inner, log, transaction))
                ) as T
        })
    });
}
