import type { PSqlParameter } from '@shared-server/postgres/p-sql-sql.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

export interface RecordedPGliteStatement {
    readonly scope: 'autocommit' | 'exec' | 'transaction';
    readonly query: string;
    readonly params: readonly PSqlParameter[];
}

export interface RecordedPGliteStatements {
    /** Every statement the PGlite instance ran, in order; the BEGIN and COMMIT of a transaction are not among them. */
    statements(): readonly RecordedPGliteStatement[];
    /** The statements run inside a transaction, in order. */
    inTransaction(): readonly RecordedPGliteStatement[];
    /** How many transactions the PGlite instance opened. */
    transactions(): number;
    /** Puts the three originals back; the caller owns this teardown. */
    restore(): void;
}

/** Records every statement of one PGlite instance until `restore()`, BEGIN and COMMIT excluded. */
export function recordPGliteStatements(raw: PGliteSql['raw']): RecordedPGliteStatements {
    const statements: RecordedPGliteStatement[] = [];
    let transactions = 0;
    const query = raw.query;
    const exec = raw.exec;
    const transaction = raw.transaction;
    raw.query = ((...args: Parameters<typeof query>) => {
        statements.push({ scope: 'autocommit', query: args[0], params: args[1] ?? [] });
        return query.apply(raw, args);
    }) as typeof query;
    raw.exec = ((...args: Parameters<typeof exec>) => {
        statements.push({ scope: 'exec', query: args[0], params: [] });
        return exec.apply(raw, args);
    }) as typeof exec;
    raw.transaction = ((callback: Parameters<typeof transaction>[0]) => {
        transactions += 1;
        return transaction.call(raw, (tx) => {
            const txQuery = tx.query.bind(tx);
            return callback(Object.assign(Object.create(tx), {
                query: (...args: Parameters<typeof tx.query>) => {
                    statements.push({ scope: 'transaction', query: args[0], params: args[1] ?? [] });
                    return txQuery(...args);
                }
            }));
        });
    }) as typeof transaction;
    return {
        statements: () => statements,
        inTransaction: () => statements.filter(({ scope }) => scope === 'transaction'),
        transactions: () => transactions,
        restore: () => {
            raw.query = query;
            raw.exec = exec;
            raw.transaction = transaction;
        }
    };
}
