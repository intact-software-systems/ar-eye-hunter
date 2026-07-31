import { type Sql } from 'postgres';
import {
  deriveApiV1StateWriteEvidence,
  parseApiV1StateWriteEvidenceRow,
} from './api-v1-state-write-evidence-derivation.ts';
import {
  type ApiV1StateWriteEvidenceSpec,
  type InboxRow,
  type OverdueRecoveryEvidence,
  type ParsedInboxRow,
  type OutboxRow,
} from './api-v1-state-write-evidence-contracts.ts';
import { readIntermediateMutationIntents } from './api-v1-state-write-intermediate-evidence.ts';
import { toExactPersistedEvidenceMatches } from './api-v1-state-write-match.ts';
import { readPersistedCommandEvidence } from './api-v1-state-write-receipt-evidence.ts';

export type ApiV1StateWriteEvidenceSqlSpec = ApiV1StateWriteEvidenceSpec;

async function readOutboxRows(sql: Sql, match: string): Promise<readonly OutboxRow[]> {
  return await sql<OutboxRow[]>`
        select ri_resource_id, ri_topic_id, ri_type_id, ri_status, ri_resource
        from resource_inbox
        where ri_type_id in ('APP_OUTBOX', 'WS_OUTBOX')
          and position(${match} in ri_resource) > 0
        order by ri_row_id
    `;
}

async function readRows(sql: Sql, match: string): Promise<readonly InboxRow[]> {
  const exactMatch = await toExactPersistedEvidenceMatches(match);
  return await sql<InboxRow[]>`
        select i.ri_row_id, i.ri_resource_id, i.ri_topic_id, i.fk_ext_bank_id,
               i.ri_resource, i.ri_status, i.ri_attempts, i.start_ts, i.end_ts, i.next_ts,
               r.ris_status as result_status, r.ris_resource as result_resource
        from resource_inbox i
        left join resource_inbox_results r
          on r.fk_ext_bank_id = i.fk_ext_bank_id
         and r.ris_resource_id = i.ri_resource_id
         and r.ris_topic_id = i.ri_topic_id
        where i.ri_type_id = 'APP_INBOX'
          and (position(${exactMatch.raw} in i.ri_resource) > 0
            or position(${exactMatch.digest} in i.ri_resource) > 0)
        order by i.ri_row_id
    `;
}

async function waitForFixtureCompletion(
  sql: Sql,
  row: ParsedInboxRow,
  timeoutMs: number,
): Promise<InboxRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<InboxRow[]>`
            select i.ri_row_id, i.ri_resource_id, i.ri_topic_id, i.fk_ext_bank_id,
                   i.ri_resource, i.ri_status, i.ri_attempts, i.start_ts, i.end_ts, i.next_ts,
                   r.ris_status as result_status, r.ris_resource as result_resource
            from resource_inbox i
            left join resource_inbox_results r
              on r.fk_ext_bank_id = i.fk_ext_bank_id
             and r.ris_resource_id = i.ri_resource_id and r.ris_topic_id = i.ri_topic_id
            where i.ri_row_id = ${row.rowId}
        `;
    const current = rows[0];
    if (current?.ri_status === 'COMPLETED' && current.result_status === 'COMPLETED') return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Overdue fairness fixture did not complete within ${timeoutMs}ms.`);
}

async function runOverdueRecoveryFixture(
  sql: Sql,
  rows: readonly InboxRow[],
  fixture: NonNullable<ApiV1StateWriteEvidenceSpec['overdueRecoveryFixture']>,
): Promise<OverdueRecoveryEvidence> {
  const parsed = rows.map((row) => parseApiV1StateWriteEvidenceRow(row));
  const commandIdPrefix = fixture.commandIdPrefix;
  const selected = parsed.find(
    (row) =>
      row.status === 'COMPLETED' &&
      row.resultStatus === 'COMPLETED' &&
      (!commandIdPrefix || row.commandIds.some((id) => id.startsWith(commandIdPrefix))) &&
      (!fixture.commandType || row.commandType === fixture.commandType),
  );
  if (!selected)
    throw new Error('No completed AppInbox row is available for the overdue fairness fixture.');
  const overdueByMs = Math.max(30_000, fixture.overdueByMs ?? 65_000);
  let dueAt = new Date(0);
  await sql.begin(async (transaction) => {
    await transaction`
            delete from resource_inbox_results
            where fk_ext_bank_id = ${selected.contextId}
              and ris_resource_id = ${selected.resourceId} and ris_topic_id = ${selected.topicId}
        `;
    const updated = await transaction<{ next_ts: Date | string }[]>`
            update resource_inbox set ri_status = 'RETRY', start_ts = null, end_ts = null,
                next_ts = current_timestamp - ${overdueByMs} * interval '1 millisecond'
            where ri_row_id = ${selected.rowId} and ri_status = 'COMPLETED'
            returning next_ts
        `;
    if (!updated[0]) throw new Error('Overdue fairness fixture row was not rescheduled.');
    dueAt = new Date(updated[0].next_ts);
  });
  const afterRaw = await waitForFixtureCompletion(sql, selected, fixture.timeoutMs ?? 20_000);
  const after = parseApiV1StateWriteEvidenceRow(afterRaw);
  const claimedAt = after.startAt ? new Date(after.startAt) : new Date(0);
  const dueAgeAtClaimMs = claimedAt.getTime() - dueAt.getTime();
  return {
    fixtureKind: 'isolated-overdue-reschedule',
    mutatesCompletionHistory: true,
    resourceId: selected.resourceId,
    commandType: selected.commandType,
    beforeStatus: selected.status,
    beforeAttempts: selected.attempts,
    injectedDueAt: dueAt.toISOString(),
    overdueByMs,
    afterStatus: after.status,
    afterResultStatus: after.resultStatus,
    afterAttempts: after.attempts,
    claimedAt: claimedAt.toISOString(),
    dueAgeAtClaimMs,
    notBeforeSatisfied: dueAgeAtClaimMs >= 0,
    overdueAtClaim: dueAgeAtClaimMs >= 30_000,
    recovered: after.status === 'COMPLETED' && after.resultStatus === 'COMPLETED',
  };
}

export async function collectApiV1StateWriteEvidenceFromSql(
  input: unknown,
  sql: Sql,
): Promise<Record<string, unknown>> {
  const spec = input as ApiV1StateWriteEvidenceSqlSpec;
  if (!spec || typeof spec.match !== 'string' || spec.match.length === 0) {
    throw new Error('stateWriteEvidence.match must be a non-empty string.');
  }
  const rows = await readRows(sql, spec.match);
  const minimum = spec.minimumMatchedRows ?? 1;
  const matching = rows
    .map((row) => parseApiV1StateWriteEvidenceRow(row))
    .filter(
      (row) =>
        (!spec.commandTypes?.length || spec.commandTypes.includes(row.commandType)) &&
        (!spec.commandIdPrefixes?.length ||
          row.commandIds.some((id) =>
            spec.commandIdPrefixes?.some((prefix) => id.startsWith(prefix)),
          )),
    );
  if (matching.length < minimum) {
    throw new Error(
      `Expected at least ${minimum} matching AppInbox rows; found ${matching.length}.`,
    );
  }
  const intermediate = await readIntermediateMutationIntents(sql, spec.match);
  const overdueRecovery = spec.overdueRecoveryFixture
    ? await runOverdueRecoveryFixture(sql, rows, spec.overdueRecoveryFixture)
    : undefined;
  const finalRows = overdueRecovery ? await readRows(sql, spec.match) : rows;
  const outboxRows = await readOutboxRows(sql, spec.match);
  const commandEvidence = await Promise.all(
    finalRows.map((row) => readPersistedCommandEvidence(sql, row)),
  );
  return deriveApiV1StateWriteEvidence(
    spec,
    finalRows,
    outboxRows,
    intermediate,
    overdueRecovery,
    commandEvidence,
  );
}
