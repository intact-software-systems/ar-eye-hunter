export type PSqlSql = {
    <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    (values: readonly unknown[]): unknown;
    begin<T>(fn: (sql: PSqlTransactionSql) => Promise<T>): Promise<T>;
};

export type PSqlTransactionSql = PSqlSql;
