import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

/** How many rows that carry a run id remain in each table a client or group test writes. */
export interface PostgresRunRowCounts {
    readonly wsOutbox: number;
    readonly resourceInbox: number;
    readonly resourceInboxResults: number;
    readonly runtimeState: number;
    readonly clientEvents: number;
    readonly groupEvents: number;
}

export const NO_POSTGRES_RUN_ROWS: PostgresRunRowCounts = {
    wsOutbox: 0,
    resourceInbox: 0,
    resourceInboxResults: 0,
    runtimeState: 0,
    clientEvents: 0,
    groupEvents: 0
};

/**
 * Removes every row a test wrote under its run id, which its scope, sessions and tickets carry in a key, an identity
 * column or the stored value: queued work such as NEW `WS_OUTBOX` rows would otherwise be claimed by a later test.
 */
export async function deletePostgresRunRows(sql: PSqlSql, runId: string): Promise<void> {
    const pattern = `%${runId}%`;
    await sql`
        delete from resource_inbox
        where ri_resource like ${pattern} or ri_resource_id like ${pattern} or fk_ext_bank_id like ${pattern}
    `;
    await sql`
        delete from resource_inbox_results
        where ris_resource like ${pattern} or ris_resource_id like ${pattern} or fk_ext_bank_id like ${pattern}
    `;
    await sql`delete from runtime_state_store where store_key like ${pattern} or store_value like ${pattern}`;
    await sql`delete from client_state_events where workspace_key like ${pattern}`;
    await sql`delete from group_state_events where workspace_key like ${pattern}`;
}

export async function readPostgresRunRowCounts(sql: PSqlSql, runId: string): Promise<PostgresRunRowCounts> {
    const pattern = `%${runId}%`;
    const [counts] = await sql<PostgresRunRowCounts[]>`
        select (select count(*) from resource_inbox
                where ri_type_id = 'WS_OUTBOX' and ri_resource like ${pattern})::int as "wsOutbox",
               (select count(*) from resource_inbox
                where ri_resource like ${pattern} or ri_resource_id like ${pattern}
                   or fk_ext_bank_id like ${pattern})::int as "resourceInbox",
               (select count(*) from resource_inbox_results
                where ris_resource like ${pattern} or ris_resource_id like ${pattern}
                   or fk_ext_bank_id like ${pattern})::int as "resourceInboxResults",
               (select count(*) from runtime_state_store
                where store_key like ${pattern} or store_value like ${pattern})::int as "runtimeState",
               (select count(*) from client_state_events where workspace_key like ${pattern})::int as "clientEvents",
               (select count(*) from group_state_events where workspace_key like ${pattern})::int as "groupEvents"
    `;
    if (counts === undefined) {
        throw new Error('The run row count returned no row');
    }
    return counts;
}
