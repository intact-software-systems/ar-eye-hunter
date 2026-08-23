import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';

export const RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;

export class PSqlResourceInboxMaintenance {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async deleteExpired(): Promise<number> {
        const rows = await this.sql<{ ri_row_id: bigint; }[]>`
            delete
            from resource_inbox
            where expire_ts <= (now() at time zone 'UTC')
            returning ri_row_id
        `;

        return rows.length;
    }
}

export async function initResourceInboxExpiryEviction(
    repository: Readonly<{ deleteExpired(): Promise<number>; }>,
    intervalMs: number = RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS
): Promise<void> {
    await tryRunInIntervals(
        async () => {
            const removed = await repository.deleteExpired();
            if (removed > 0) {
                console.log(`Evicted expired resource_inbox rows: ${removed}`);
            }
        },
        intervalMs
    );
}
