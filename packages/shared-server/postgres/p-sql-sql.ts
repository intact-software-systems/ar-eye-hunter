export type PSqlParameter = string | number | boolean | bigint | Date | null | undefined | object;
export type PSqlRows = readonly (object | undefined)[];

export interface PSqlQuery {
    <Rows extends PSqlRows>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Rows>;
}

export interface PSqlSql extends PSqlQuery {
    (values: readonly PSqlParameter[]): object;
    begin<T>(fn: (sql: PSqlSql) => Promise<T>): Promise<T>;
}
