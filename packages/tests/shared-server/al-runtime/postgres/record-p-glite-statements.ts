import { vi } from 'vitest';

import type { PSqlParameter } from '@shared-server/postgres/p-sql-sql.ts';

import type { PGliteSql } from '../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

export interface RecordedPGliteStatement {
    readonly scope: 'autocommit' | 'exec' | 'transaction';
    readonly query: string;
    readonly params: readonly PSqlParameter[];
}

export interface RecordedPGliteStatements {
    /** Every statement the PGlite instance ran, in order; the BEGIN and COMMIT of a transaction are not among them. */
    statements(): readonly RecordedPGliteStatement[];
    /** How many transactions the PGlite instance opened. */
    transactions(): number;
}

/**
 * Patches `query`, `exec` and `transaction` of one PGlite instance for the rest of the test: the caller
 * owns the teardown, and every suite using this needs `vi.restoreAllMocks()` in an `afterEach`.
 */
export function recordPGliteStatements(raw: PGliteSql['raw']): RecordedPGliteStatements {
    const statements: RecordedPGliteStatement[] = [];
    let transactions = 0;
    const query = raw.query.bind(raw);
    const exec = raw.exec.bind(raw);
    const transaction = raw.transaction.bind(raw);
    vi.spyOn(raw, 'query').mockImplementation((...args: Parameters<typeof raw.query>) => {
        statements.push({ scope: 'autocommit', query: args[0], params: args[1] ?? [] });
        return query(...args);
    });
    vi.spyOn(raw, 'exec').mockImplementation((...args: Parameters<typeof raw.exec>) => {
        statements.push({ scope: 'exec', query: args[0], params: [] });
        return exec(...args);
    });
    vi.spyOn(raw, 'transaction').mockImplementation((callback) => {
        transactions += 1;
        return transaction((tx) => {
            const txQuery = tx.query.bind(tx);
            return callback(Object.assign(Object.create(tx), {
                query: (...args: Parameters<typeof tx.query>) => {
                    statements.push({ scope: 'transaction', query: args[0], params: args[1] ?? [] });
                    return txQuery(...args);
                }
            }));
        });
    });
    return { statements: () => statements, transactions: () => transactions };
}
