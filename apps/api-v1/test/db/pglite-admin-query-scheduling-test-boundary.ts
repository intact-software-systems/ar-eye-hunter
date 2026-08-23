import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

interface AdminQueryLaunchEvidence {
    readonly runtimeFactQueries: number;
    readonly recentEventQueries: readonly string[];
}

interface DelayedAdminRuntimeFactQueries {
    readonly sql: PSqlSql;
    releaseRuntimeFacts(): void;
    readLaunchEvidence(): AdminQueryLaunchEvidence;
}

export function delayAdminRuntimeFactQueries(
    sql: PGliteSql
): DelayedAdminRuntimeFactQueries {
    const gate = Promise.withResolvers<void>();
    let runtimeFactQueries = 0;
    const recentEventQueries: string[] = [];
    const delayed = (function<Rows extends PSqlRows> (
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: PSqlParameter[]
    ): Promise<Rows> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        const queryText = Array.from(stringsOrValues).join('?').toLowerCase();
        if (queryText.includes('from client_state_events')) {
            recentEventQueries.push('client');
        }
        if (queryText.includes('from group_state_events')) {
            recentEventQueries.push('group');
        }
        const isRuntimeFactQuery = queryText.includes('from runtime_state_store');
        if (isRuntimeFactQuery) {
            runtimeFactQueries += 1;
        }
        const result = sql<Rows>(stringsOrValues, ...values);
        if (!isRuntimeFactQuery) {
            return result;
        }
        return result.then(async (rows) => {
            await gate.promise;
            return rows;
        });
    }) as PSqlSql;
    delayed.begin = sql.begin.bind(sql);
    return {
        sql: delayed,
        releaseRuntimeFacts: gate.resolve,
        readLaunchEvidence: () => ({
            runtimeFactQueries,
            recentEventQueries: [...recentEventQueries]
        })
    };
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
