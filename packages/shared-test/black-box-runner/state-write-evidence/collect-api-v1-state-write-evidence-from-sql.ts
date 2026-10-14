import { Temporal } from '@js-temporal/polyfill';

import {
    type ApiV1StateWriteEvidence,
    type ApiV1StateWriteEvidenceQuery,
    type ApiV1StateWriteEvidenceSpec,
    type ApiV1StateWriteEvidenceSql,
    type InboxRow,
    type OutboxRow,
    type OverdueRecoveryEvidence,
    type ParsedInboxRow
} from './api-v1-state-write-evidence-contracts.ts';
import {
    deriveApiV1StateWriteEvidence,
    parseApiV1StateWriteEvidenceRow
} from './api-v1-state-write-evidence-derivation.ts';
import { readPersistedCommandEvidence } from './api-v1-state-write-receipt-evidence.ts';
import { readIntermediateMutationIntents } from './read-intermediate-mutation-intents.ts';
import { toApiV1StateWriteEvidenceSpec } from './to-api-v1-state-write-evidence-spec.ts';
import { toExactPersistedEvidenceMatches } from './to-exact-persisted-evidence-matches.ts';
import { toStateWriteEvidenceInstant } from './to-state-write-evidence-instant.ts';

interface FixtureCompletionWaitInput {
    readonly sql: ApiV1StateWriteEvidenceQuery;
    readonly row: ParsedInboxRow;
    readonly timeoutMs: number;
    readonly now: () => number;
}

export async function collectApiV1StateWriteEvidenceFromSql(
    input: unknown,
    sql: ApiV1StateWriteEvidenceSql
): Promise<ApiV1StateWriteEvidence> {
    const spec = toApiV1StateWriteEvidenceSpec(input);
    const rows = await readRows(sql, spec.match);
    const minimum = spec.minimumMatchedRows ?? 1;
    const matching = rows
        .map((row) => parseApiV1StateWriteEvidenceRow(row))
        .filter(
            (row) =>
                (!spec.commandTypes?.length ||
                    spec.commandTypes.includes(row.commandType)) &&
                (!spec.commandIdPrefixes?.length ||
                    row.commandIds.some((id) => spec.commandIdPrefixes?.some((prefix) => id.startsWith(prefix))))
        );
    if (matching.length < minimum) {
        throw new Error(
            `Expected at least ${minimum} matching AppInbox rows; found ${matching.length}.`
        );
    }
    const intermediate = await readIntermediateMutationIntents(sql, spec.match);
    const naturalRetryEvidence = spec.overdueRecoveryFixture
        ? await readNaturalRetryEvidence(sql, spec, rows)
        : undefined;
    const overdueRecovery = spec.overdueRecoveryFixture
        ? await runOverdueRecoveryFixture(sql, rows, spec.overdueRecoveryFixture)
        : undefined;
    const finalRows = overdueRecovery ? await readRows(sql, spec.match) : rows;
    const commandEvidence = await Promise.all(
        finalRows.map((row) => readPersistedCommandEvidence(sql, row))
    );
    const outboxRows = await readOutboxRows(sql, [
        spec.match,
        ...commandEvidence.flatMap((evidence) => evidence.commandIds)
    ]);
    const finalEvidence = deriveApiV1StateWriteEvidence({
        spec: spec,
        rawRows: finalRows,
        rawOutboxRows: outboxRows,
        intermediateMutationIntents: intermediate,
        overdueRecoveryFixture: overdueRecovery,
        commandEvidence: commandEvidence
    });
    return {
        ...finalEvidence,
        ...(naturalRetryEvidence
            ? {
                naturalBoundedRetryCount: naturalRetryEvidence.naturalBoundedRetryCount,
                naturalBoundedRetries: naturalRetryEvidence.naturalBoundedRetries,
                naturalBoundedRetryObserved: naturalRetryEvidence.naturalBoundedRetryObserved,
                naturalRetryEvidenceGap: naturalRetryEvidence.naturalRetryEvidenceGap
            }
            : {})
    };
}

async function readOutboxRows(
    sql: ApiV1StateWriteEvidenceQuery,
    matches: readonly string[]
): Promise<readonly OutboxRow[]> {
    const rows = await Promise.all(
        [...new Set(matches)].map(async (match) =>
            await sql<OutboxRow[]>`
                select ri_resource_id, ri_topic_id, fk_ext_bank_id, ri_type_id, ri_status, ri_resource
                from resource_inbox
                where ri_type_id in ('APP_OUTBOX', 'WS_OUTBOX')
                  and position(${match} in ri_resource) > 0
                order by ri_row_id
            `
        )
    );
    return [...new Map(rows.flatMap((batch) =>
        batch.map((row) =>
            [
                [
                    row.ri_type_id,
                    row.ri_topic_id,
                    row.ri_resource_id,
                    row.fk_ext_bank_id,
                    row.ri_resource
                ].join('\0'),
                row
            ] as const
        )
    )).values()];
}

async function readRows(
    sql: ApiV1StateWriteEvidenceQuery,
    match: string
): Promise<readonly InboxRow[]> {
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

async function waitForFixtureCompletion(input: FixtureCompletionWaitInput): Promise<InboxRow> {
    const deadline = input.now() + input.timeoutMs;
    while (input.now() < deadline) {
        const rows = await input.sql<InboxRow[]>`
            select i.ri_row_id, i.ri_resource_id, i.ri_topic_id, i.fk_ext_bank_id,
                   i.ri_resource, i.ri_status, i.ri_attempts, i.start_ts, i.end_ts, i.next_ts,
                   r.ris_status as result_status, r.ris_resource as result_resource
            from resource_inbox i
            left join resource_inbox_results r
              on r.fk_ext_bank_id = i.fk_ext_bank_id
             and r.ris_resource_id = i.ri_resource_id and r.ris_topic_id = i.ri_topic_id
            where i.ri_row_id = ${input.row.rowId}
        `;
        const current = rows[0];
        if (current?.ri_status === 'COMPLETED' && current.result_status === 'COMPLETED') {
            return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Overdue fairness fixture did not complete within ${input.timeoutMs}ms.`);
}

async function runOverdueRecoveryFixture(
    sql: ApiV1StateWriteEvidenceSql,
    rows: readonly InboxRow[],
    fixture: NonNullable<ApiV1StateWriteEvidenceSpec['overdueRecoveryFixture']>
): Promise<OverdueRecoveryEvidence> {
    const parsed = rows.map((row) => parseApiV1StateWriteEvidenceRow(row));
    const commandIdPrefix = fixture.commandIdPrefix;
    const selected = parsed.find(
        (row) =>
            row.status === 'COMPLETED' &&
            row.resultStatus === 'COMPLETED' &&
            (!commandIdPrefix ||
                row.commandIds.some((id) => id.startsWith(commandIdPrefix))) &&
            (!fixture.commandType || row.commandType === fixture.commandType)
    );
    if (!selected) {
        throw new Error(
            'No completed AppInbox row is available for the overdue fairness fixture.'
        );
    }
    const overdueByMs = Math.max(30_000, fixture.overdueByMs ?? 65_000);
    const dueAt = await rescheduleOverdueFixture(sql, selected, overdueByMs);
    const afterRaw = await waitForFixtureCompletion({
        sql,
        row: selected,
        timeoutMs: fixture.timeoutMs ?? 20_000,
        now: Date.now
    });
    const after = parseApiV1StateWriteEvidenceRow(afterRaw);
    const claimedAt = toStateWriteEvidenceInstant(after.startAt ?? new Date(0));
    const dueAgeAtClaimMs = claimedAt.epochMilliseconds - dueAt.epochMilliseconds;
    return {
        fixtureKind: 'isolated-overdue-reschedule',
        mutatesCompletionHistory: true,
        resourceId: selected.resourceId,
        commandType: selected.commandType,
        beforeStatus: selected.status,
        beforeAttempts: selected.attempts,
        injectedDueAt: dueAt.toString(),
        overdueByMs,
        afterStatus: after.status,
        afterResultStatus: after.resultStatus,
        afterAttempts: after.attempts,
        claimedAt: claimedAt.toString(),
        dueAgeAtClaimMs,
        notBeforeSatisfied: dueAgeAtClaimMs >= 0,
        overdueAtClaim: dueAgeAtClaimMs >= 30_000,
        recovered: after.status === 'COMPLETED' &&
            after.resultStatus === 'COMPLETED'
    };
}

async function rescheduleOverdueFixture(
    sql: ApiV1StateWriteEvidenceSql,
    selected: ParsedInboxRow,
    overdueByMs: number
): Promise<Temporal.Instant> {
    let dueAt = Temporal.Instant.fromEpochMilliseconds(0);
    await sql.begin(async (transaction) => {
        await transaction`
            delete from resource_inbox_results
            where fk_ext_bank_id = ${selected.contextId}
              and ris_resource_id = ${selected.resourceId} and ris_topic_id = ${selected.topicId}
        `;
        const updated = await transaction<{ next_ts: Date | string; }[]>`
            update resource_inbox set ri_status = 'RETRY',
                next_ts = (current_timestamp at time zone 'UTC') - ${overdueByMs} * interval '1 millisecond'
            where ri_row_id = ${selected.rowId} and ri_status = 'COMPLETED'
            returning next_ts
        `;
        if (!updated[0]) {
            throw new Error('Overdue fairness fixture row was not rescheduled.');
        }
        dueAt = toStateWriteEvidenceInstant(updated[0].next_ts);
    });
    return dueAt;
}

/** Capture real natural observations before the isolated fixture changes completion history. */
async function readNaturalRetryEvidence(
    sql: ApiV1StateWriteEvidenceQuery,
    spec: ApiV1StateWriteEvidenceSpec,
    rows: readonly InboxRow[]
): Promise<ApiV1StateWriteEvidence> {
    const commandEvidence = await Promise.all(rows.map((row) => readPersistedCommandEvidence(sql, row)));
    return deriveApiV1StateWriteEvidence({
        spec: spec,
        rawRows: rows,
        rawOutboxRows: undefined,
        intermediateMutationIntents: undefined,
        overdueRecoveryFixture: undefined,
        commandEvidence: commandEvidence
    });
}
