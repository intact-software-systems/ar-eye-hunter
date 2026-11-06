import { PSqlFragment } from '../../postgres/p-sql-fragment.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { RuntimeStateObservations } from '../observation/runtime-state-observation.ts';

/**
 * Inside the caller's transaction: whether every observed row still holds its observed revision, value and expiry,
 * and every row observed absent is still missing or expired.
 * Nothing is locked or rewritten, so a writer of an observed row never conflicts with the observer's own rows.
 */
export async function readRuntimeStateObservationsCurrent(
    sql: PSqlSql,
    observations: RuntimeStateObservations
): Promise<boolean> {
    if (observations.count === 0) {
        return true;
    }
    const statement = PSqlFragment.of`
        select count(*)::int as changed
        from jsonb_to_recordset(${observations.observationsJson}::text::jsonb)
            as observed(namespace text, key text, revision bigint, value text, expires text)
        left join runtime_state_store as observation
          on observation.store_namespace = observed.namespace and observation.store_key = observed.key
        where case
            when observed.revision is null then observation.expire_at_ts > now()
            else observation.revision is distinct from observed.revision
              or observation.store_value is distinct from observed.value
              or observation.expire_at_ts is distinct from observed.expires::timestamptz
        end
    `.toPlannedPerExecution();
    const rows = await sql<{ changed: number; }[]>(...statement.toStatement());
    if (rows.length !== 1) {
        throw new TypeError('Runtime-state observation check returned no single count');
    }
    return rows[0].changed === 0;
}
