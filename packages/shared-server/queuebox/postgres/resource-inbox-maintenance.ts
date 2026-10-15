import { tryRunInIntervals } from '@shared/resilience/try-with-policy.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';

export const RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;

export interface ResourceInboxExpiredRowOwners {
    readonly entries: ExpiredRowOwner;
    readonly results: ExpiredRowOwner;
}

interface ExpiredRowOwner {
    deleteExpired(): Promise<number>;
}

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
    owners: ResourceInboxExpiredRowOwners,
    intervalMs: number = RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS
): Promise<void> {
    await tryRunInIntervals({
        handler: async () => {
            const removedEntries = await owners.entries.deleteExpired();
            if (removedEntries > 0) {
                console.log(`Evicted expired resource_inbox rows: ${removedEntries}`);
            }
            const removedResults = await owners.results.deleteExpired();
            if (removedResults > 0) {
                console.log(`Evicted expired resource_inbox_results rows: ${removedResults}`);
            }
        },
        intervalMsecs: intervalMs,
        retryIntervalMsecs: 10_000,
        maxAttempts: Number.MAX_VALUE
    });
}
