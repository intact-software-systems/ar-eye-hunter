import { describe, expect, it } from 'vitest';

import type {
    PSqlExecutorCounters,
    PSqlParameter,
    PSqlSql,
    PSqlTransactionWrite
} from '@shared-server/postgres/p-sql-sql.ts';

import { createDelayedPSqlSql } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/instance/create-delayed-p-sql-sql.ts';

/** What a recording handle answers a statement with: the text it was sent and the values bound to it. */
interface RecordedStatement {
    readonly text: string;
    readonly values: readonly PSqlParameter[];
}

interface RecordingSql extends PSqlSql {
    readonly counters: PSqlExecutorCounters;
}

interface RecordingTransactionSql extends RecordingSql {
    savepoint<Result>(write: PSqlTransactionWrite<Result>): Promise<Result>;
}

const DELAY_MS = 5;

/** Logs `statement` as a template call reaches it; a values call answers a fragment and logs nothing. */
function createRecordingQuery(log: string[]) {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<RecordedStatement> | object {
        if (!('raw' in stringsOrValues)) {
            return { fragmentOf: stringsOrValues };
        }
        log.push('statement');
        return Promise.resolve({ text: stringsOrValues.join('?'), values });
    }
    return sql;
}

/** A root handle: it opens transactions and has no savepoint. Its counters need their receiver, as a native handle's may. */
function createRecordingSql(log: string[]): RecordingSql {
    return Object.assign(createRecordingQuery(log), {
        counters: { statements: 3, executorWaitMs: 7 },
        getExecutorCounters(this: RecordingSql): PSqlExecutorCounters {
            return this.counters;
        },
        async begin<Result>(write: PSqlTransactionWrite<Result>): Promise<Result> {
            log.push('begin');
            try {
                const result = await write(createRecordingTransactionSql(log));
                log.push('commit');
                return result;
            }
            catch (error) {
                log.push('rollback');
                throw error;
            }
        }
    });
}

/**
 * A transaction handle as postgres.js gives one: a savepoint is one statement as it opens, nothing more when its write
 * resolves, and a `rollback to` when its write rejects. A nested `begin` is that same savepoint.
 */
function createRecordingTransactionSql(log: string[]): RecordingTransactionSql {
    const savepoint = async <Result>(write: PSqlTransactionWrite<Result>): Promise<Result> => {
        log.push('savepoint');
        try {
            return await write(createRecordingTransactionSql(log));
        }
        catch (error) {
            log.push('rollback to');
            throw error;
        }
    };
    return Object.assign(createRecordingQuery(log), {
        counters: { statements: 4, executorWaitMs: 9 },
        getExecutorCounters(this: RecordingSql): PSqlExecutorCounters {
            return this.counters;
        },
        begin: savepoint,
        savepoint
    });
}

function createRecordingSleep(log: string[]): (delayMs: number) => Promise<void> {
    return async (delayMs) => {
        log.push(`sleep ${delayMs}`);
    };
}

function hasSavepoint(sql: PSqlSql): sql is PSqlSql & Pick<RecordingTransactionSql, 'savepoint'> {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}

/** The two ways a transaction handle opens a savepoint. */
type SavepointOpener = 'savepoint' | 'begin';

async function openSavepoint<Result>(
    transaction: PSqlSql,
    opener: SavepointOpener,
    write: PSqlTransactionWrite<Result>
): Promise<Result> {
    if (opener === 'begin') {
        return await transaction.begin(write);
    }
    if (!hasSavepoint(transaction)) {
        throw new Error('The delayed transaction lost its savepoint');
    }
    return await transaction.savepoint(write);
}

describe('createDelayedPSqlSql', () => {
    it('delays a transaction inside it: after its BEGIN, before each of its statements, and before its COMMIT', async () => {
        const log: string[] = [];
        const delayed = createDelayedPSqlSql({
            sql: createRecordingSql(log),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        const written = await delayed.begin(async (transaction) => [
            await transaction<RecordedStatement>`select ${1}`,
            await transaction<RecordedStatement>`select ${2}`
        ]);

        expect(log).toEqual([
            'begin',
            'sleep 5',
            'sleep 5',
            'statement',
            'sleep 5',
            'statement',
            'sleep 5',
            'commit'
        ]);
        expect(written).toEqual([{ text: 'select ?', values: [1] }, { text: 'select ?', values: [2] }]);
    });

    it('delays an autocommit statement once, before it is sent', async () => {
        const log: string[] = [];
        const delayed = createDelayedPSqlSql({
            sql: createRecordingSql(log),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        const answered = await delayed<RecordedStatement>`select ${'a'}, ${'b'}`;

        expect(log).toEqual(['sleep 5', 'statement']);
        expect(answered).toEqual({ text: 'select ?, ?', values: ['a', 'b'] });
    });

    it('returns the handle it was given when the delay is 0 ms', () => {
        const log: string[] = [];
        const sql = createRecordingSql(log);

        expect(createDelayedPSqlSql({ sql, delayMs: 0, sleep: createRecordingSleep(log) })).toBe(sql);
    });

    it('delays a failing transaction inside it, before its ROLLBACK, then rejects with the same error', async () => {
        const log: string[] = [];
        const failure = new Error('the write failed');
        const delayed = createDelayedPSqlSql({
            sql: createRecordingSql(log),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        await expect(delayed.begin(async (transaction) => {
            await transaction`select 1`;
            throw failure;
        })).rejects.toBe(failure);

        expect(log).toEqual(['begin', 'sleep 5', 'sleep 5', 'statement', 'sleep 5', 'rollback']);
    });

    it('passes a values call through undelayed', () => {
        const log: string[] = [];
        const values = [1, 2];
        const delayed = createDelayedPSqlSql({
            sql: createRecordingSql(log),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        expect(delayed(values)).toEqual({ fragmentOf: values });
        expect(log).toEqual([]);
    });

    it.each<SavepointOpener>(['savepoint', 'begin'])(
        'delays a savepoint opened by %s once, before it opens, and not again when it resolves',
        async (opener) => {
            const log: string[] = [];
            const delayed = createDelayedPSqlSql({
                sql: createRecordingTransactionSql(log),
                delayMs: DELAY_MS,
                sleep: createRecordingSleep(log)
            });

            const answered = await openSavepoint(delayed, opener, async (nested) => await nested<RecordedStatement>`select ${1}`);

            expect(log).toEqual(['sleep 5', 'savepoint', 'sleep 5', 'statement']);
            expect(answered).toEqual({ text: 'select ?', values: [1] });
        }
    );

    it.each<SavepointOpener>(['savepoint', 'begin'])(
        'delays a failing savepoint opened by %s again after its ROLLBACK TO, then rejects with the same error',
        async (opener) => {
            const log: string[] = [];
            const failure = new Error('the nested write failed');
            const delayed = createDelayedPSqlSql({
                sql: createRecordingTransactionSql(log),
                delayMs: DELAY_MS,
                sleep: createRecordingSleep(log)
            });

            await expect(openSavepoint(delayed, opener, async (nested) => {
                await nested`select 1`;
                throw failure;
            })).rejects.toBe(failure);

            expect(log).toEqual(['sleep 5', 'savepoint', 'sleep 5', 'statement', 'rollback to', 'sleep 5']);
        }
    );

    it('keeps the counters of each wrapped handle, and the savepoint of a transaction it opens', async () => {
        const log: string[] = [];
        const delayed = createDelayedPSqlSql({
            sql: createRecordingSql(log),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        const transactionCounters = await delayed.begin(async (transaction) => {
            await openSavepoint(transaction, 'savepoint', async (nested) => await nested`select 1`);
            return transaction.getExecutorCounters?.();
        });

        expect(delayed.getExecutorCounters?.()).toEqual({ statements: 3, executorWaitMs: 7 });
        expect(transactionCounters).toEqual({ statements: 4, executorWaitMs: 9 });
        expect(log).toEqual(['begin', 'sleep 5', 'sleep 5', 'savepoint', 'sleep 5', 'statement', 'sleep 5', 'commit']);
    });

    it('gives a handle that has no savepoint and no counters neither', () => {
        const log: string[] = [];
        const bareSql: PSqlSql = Object.assign(createRecordingQuery(log), {
            begin: async <Result>(write: PSqlTransactionWrite<Result>): Promise<Result> => await write(createRecordingTransactionSql(log))
        });

        const delayed = createDelayedPSqlSql({ sql: bareSql, delayMs: DELAY_MS, sleep: createRecordingSleep(log) });

        expect(delayed.getExecutorCounters).toBeUndefined();
        expect(hasSavepoint(delayed)).toBe(false);
    });
});
