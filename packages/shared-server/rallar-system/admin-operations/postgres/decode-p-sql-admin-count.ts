export interface PSqlAdminCountRow {
    readonly count: number | string | bigint;
}

export function decodePSqlAdminCount(
    value: PSqlAdminCountRow['count'] | null | undefined
): number {
    if (value === undefined || value === null) {
        return 0;
    }
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) {
        throw new TypeError('PostgreSQL admin count is invalid');
    }
    return count;
}
