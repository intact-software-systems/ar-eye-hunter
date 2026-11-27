import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { createPostgresSqlCall } from './create-postgres-sql-call.ts';

export interface RecordedPostgresStatement {
    /** The recorded transaction the statement ran in, numbered from one; `null` for an autocommit statement. */
    readonly transaction: number | null;
    readonly text: string;
    readonly values: readonly PSqlParameter[];
    readonly rowCount: number;
}

/** What a statement-count pin compares: the statement's leading verb and the transaction it ran in. */
export interface RecordedPostgresStatementShape {
    readonly verb: string;
    readonly transaction: number | null;
}

export interface PostgresStatementLog {
    readonly statements: RecordedPostgresStatement[];
    transactions: number;
}

export function toRecordedPostgresStatementShape(statement: RecordedPostgresStatement): RecordedPostgresStatementShape {
    return { verb: statement.text.split(' ', 1)[0] ?? '', transaction: statement.transaction };
}

/**
 * Records every template statement with its values, its row count and the transaction it ran in, as it answers.
 * Forwards a client's `savepoint`, recording inside it; does not forward `getExecutorCounters`.
 */
export function recordPostgresStatements(
    source: PSqlSql,
    log: PostgresStatementLog,
    transaction: number | null
): PSqlSql {
    const recording = createPostgresSqlCall(
        source,
        async <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result> => {
            const text = strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase();
            const rows = await source<Result>(strings, ...values);
            log.statements.push({ transaction, text, values, rowCount: Array.isArray(rows) ? rows.length : 0 });
            return rows;
        }
    );
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
