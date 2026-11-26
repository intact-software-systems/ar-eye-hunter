import { describe, expect, it } from 'vitest';

import type {
    PSqlExecutorCounters,
    PSqlParameter,
    PSqlSql,
    PSqlTransactionWrite
} from '@shared-server/postgres/p-sql-sql.ts';

import { createDelayedPSqlSql } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/create-delayed-p-sql-sql.ts';

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

function createRecordingTransactionSql(log: string[]): RecordingTransactionSql {
    const savepoint = async <Result>(write: PSqlTransactionWrite<Result>): Promise<Result> => {
        log.push('savepoint');
        const result = await write(createRecordingTransactionSql(log));
        log.push('release');
        return result;
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

describe('createDelayedPSqlSql', () => {
    it('delays a transaction at BEGIN, before each of its statements, and after COMMIT', async () => {
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
            'sleep 5',
            'begin',
            'sleep 5',
            'statement',
            'sleep 5',
            'statement',
            'commit',
            'sleep 5'
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

    it('delays a failing transaction at its ROLLBACK, then rejects with the same error', async () => {
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

        expect(log).toEqual(['sleep 5', 'begin', 'sleep 5', 'statement', 'rollback', 'sleep 5']);
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

    it('keeps the counters of each wrapped handle and delays a savepoint as it delays a transaction', async () => {
        const log: string[] = [];
        const delayed = createDelayedPSqlSql({
            sql: createRecordingSql(log),
            delayMs: DELAY_MS,
            sleep: createRecordingSleep(log)
        });

        const transactionCounters = await delayed.begin(async (transaction) => {
            if (!hasSavepoint(transaction)) {
                throw new Error('The delayed transaction lost its savepoint');
            }
            await transaction.savepoint(async (nested) => await nested`select 1`);
            return transaction.getExecutorCounters?.();
        });

        expect(delayed.getExecutorCounters?.()).toEqual({ statements: 3, executorWaitMs: 7 });
        expect(transactionCounters).toEqual({ statements: 4, executorWaitMs: 9 });
        expect(log).toEqual([
            'sleep 5',
            'begin',
            'sleep 5',
            'savepoint',
            'sleep 5',
            'statement',
            'release',
            'sleep 5',
            'commit',
            'sleep 5'
        ]);
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
