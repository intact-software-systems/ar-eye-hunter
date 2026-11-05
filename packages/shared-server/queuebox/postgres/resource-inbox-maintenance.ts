import type { Timers } from '@shared/resilience/timers.ts';
import { startDrainableRepeating } from '@shared/resilience/timing/start-drainable-repeating.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';

export const RESOURCE_INBOX_EXPIRY_EVICTION_INTERVAL_MS = 15_000;

export interface ResourceInboxExpiryInput {
    readonly timers: Timers;
    readonly intervalMs: number;
    readonly onFailure: (error: Error) => void;
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

/** Cancels the next eviction and drains both table writes before the SQL owner can close. */
export function startResourceInboxExpiryEviction(input: ResourceInboxExpiryInput): () => Promise<void> {
    return startDrainableRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: 'now',
        retryBackoff: { baseMs: 10000, maxMs: 20000 },
        onFailure: input.onFailure,
        run: () => evictResourceInbox(input)
    });
}

async function evictResourceInbox(owners: ResourceInboxExpiryInput): Promise<void> {
    const removedEntries = await owners.entries.deleteExpired();
    if (removedEntries > 0) {
        console.log(`Evicted expired resource_inbox rows: ${removedEntries}`);
    }
    const removedResults = await owners.results.deleteExpired();
    if (removedResults > 0) {
        console.log(`Evicted expired resource_inbox_results rows: ${removedResults}`);
    }
}
