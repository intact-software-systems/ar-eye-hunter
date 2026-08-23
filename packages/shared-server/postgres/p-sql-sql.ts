export type PSqlParameter = string | number | boolean | bigint | Date | null | undefined | object;
export type PSqlRows = readonly (object | undefined)[];

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
    begin<T>(fn: (sql: PSqlSql) => Promise<T>): Promise<T>;
}
