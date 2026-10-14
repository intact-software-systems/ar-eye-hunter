export type PSqlParameter = string | number | boolean | bigint | Date | null | undefined | object;
export type PSqlRows = readonly (object | undefined)[];

/**
 * One write invocation per begin attempt, using transaction-bound SQL; no callback retry.
 * Rejection exits that attempt. Top-level begin owns rollback and resolves after commit; a
 * transaction-bound adapter may join the existing scope. The caller owns retries.
 */
export type PSqlTransactionWrite<Result> = (transaction: PSqlSql) => Promise<Result>;

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
}
