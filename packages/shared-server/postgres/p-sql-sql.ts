export type PSqlParameter = string | number | boolean | bigint | Date | null | undefined | object;
export type PSqlRows = readonly (object | undefined)[];

/**
 * One write invocation per begin attempt, using transaction-bound SQL; no callback retry.
 * Rejection exits that attempt. Top-level begin owns rollback and resolves after commit; a
 * transaction-bound adapter may join the existing scope. The caller owns retries.
 */
export type PSqlTransactionWrite<Result> = (transaction: PSqlSql) => Promise<Result>;

/**
 * Monotonic for the executor's lifetime and shared by every handle bound to it, so a delta between
 * two reads is the executor's work in between, including statements other callers issued on it.
 * Neither PGlite nor postgres.js exposes when a queued statement was accepted, so the wait is each
 * statement's call-to-completion time: queueing behind the executor's other statements plus its
 * own execution.
 */
export interface PSqlExecutorCounters {
    readonly statements: number;
    readonly executorWaitMs: number;
}

export interface PSqlQuery {
    <Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
}

export interface PSqlSql {
    <Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    (values: readonly PSqlParameter[]): object;
    begin<T>(write: PSqlTransactionWrite<T>): Promise<T>;
    /** A snapshot of the executor's counters; absent on a port that does not count, such as a bare client. */
    getExecutorCounters?(): PSqlExecutorCounters;
}
