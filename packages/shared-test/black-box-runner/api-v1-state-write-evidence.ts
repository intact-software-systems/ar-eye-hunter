import process from 'node:process';
import postgres, { type Sql } from 'postgres';
import {
    collectEvidenceNamedStrings,
    nestedEvidenceJson,
    parseEvidenceJson,
    type ReceiptEffectIdentityKind,
    validatePersistedAppInboxResult,
} from './api-v1-state-write-result-evidence.ts';
type EvidenceSpec = Readonly<{
    match: string
    commandTypes?: readonly string[]
    commandIdPrefixes?: readonly string[]
    minimumMatchedRows?: number
    evidenceSampleLimit?: number
    expectedEffectsByCommandType?: Readonly<Record<string, readonly string[]>>
    overdueRecoveryFixture?: Readonly<{
        commandType?: string
        commandIdPrefix?: string
        overdueByMs?: number
        timeoutMs?: number
    }>
}>
type OutboxRow = Readonly<{
    ri_resource_id: string
    ri_topic_id: string
    ri_type_id: string
    ri_status: string
    ri_resource: string
}>

type InboxRow = Readonly<{
    ri_row_id: number | string
    ri_resource_id: string
    ri_topic_id: string
    fk_ext_bank_id: string
    ri_resource: string
    ri_status: string
    ri_attempts: number | string
    start_ts: Date | string | null
    end_ts: Date | string | null
    next_ts: Date | string | null
    result_status: string | null
    result_resource: string | null
}>

type ParsedInboxRow = Readonly<{
    rowId: number
    resourceId: string
    topicId: string
    contextId: string
    commandType: string
    commandIds: readonly string[]
    status: string
    resultStatus: string
    attempts: number
    startAt: string | null
    endAt: string | null
    nextAt: string | null
    outboxIds: readonly string[]
    durableResult: unknown
    durableResultValid: boolean
    durableResultFailure?: string
    receipt?: Readonly<{ commandId: string; outboxIds: readonly string[];
        identityKind: ReceiptEffectIdentityKind }>
}>

type OverdueRecoveryEvidence = Readonly<{
    fixtureKind: 'isolated-overdue-reschedule'
    mutatesCompletionHistory: true
    resourceId: string
    commandType: string
    beforeStatus: string
    beforeAttempts: number
    injectedDueAt: string
    overdueByMs: number
    afterStatus: string
    afterResultStatus: string
    afterAttempts: number
    claimedAt: string
    dueAgeAtClaimMs: number
    notBeforeSatisfied: boolean
    overdueAtClaim: boolean
    recovered: boolean
}>

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/appdb';

function parseRow(row: InboxRow): ParsedInboxRow {
    const envelope = parseEvidenceJson(row.ri_resource) as { payload?: { typeId?: unknown } } | undefined;
    const commandType = typeof envelope?.payload?.typeId === 'string' ? envelope.payload.typeId : 'UNKNOWN';
    const commandIds = new Set<string>();
    collectEvidenceNamedStrings(envelope, new Set(['commandId', 'deliveryId', 'jobId', 'requestId', 'updateId']), commandIds);
    const resultEvidence = validatePersistedAppInboxResult({
        commandType,
        commandIds: [...commandIds],
        resultStatus: row.result_status ?? 'MISSING',
        resultResource: row.result_resource,
    });
    const iso = (value: Date | string | null): string | null => value ? new Date(value).toISOString() : null;
    return {
        rowId: Number(row.ri_row_id), resourceId: row.ri_resource_id,
        topicId: row.ri_topic_id, contextId: row.fk_ext_bank_id,
        commandType, commandIds: [...commandIds].sort(), status: row.ri_status,
        resultStatus: row.result_status ?? 'MISSING', attempts: Number(row.ri_attempts),
        startAt: iso(row.start_ts), endAt: iso(row.end_ts), nextAt: iso(row.next_ts),
        outboxIds: [...(resultEvidence.receipt?.outboxIds ?? [])].sort(),
        durableResult: resultEvidence.result,
        durableResultValid: resultEvidence.valid,
        ...(resultEvidence.failure ? { durableResultFailure: resultEvidence.failure } : {}),
        ...(resultEvidence.receipt ? { receipt: resultEvidence.receipt } : {}),
    };
}

function canonicalEffect(row: OutboxRow): Readonly<{
    commandId: string; effectKind: string; outboxId: string
}> | undefined {
    const envelope = parseEvidenceJson(row.ri_resource) as {
        id?: { msgId?: unknown }
        route?: { contextId?: unknown }
        payload?: { typeId?: unknown; resource?: unknown }
    } | undefined;
    const msgId = envelope?.id?.msgId;
    if (typeof msgId !== 'string') return undefined;
    for (const marker of [':rtc-topology-recompute:', ':group-presence-summary:', ':principal-state:']) {
        const index = msgId.indexOf(marker);
        if (index > 0) {
            return { commandId: msgId.slice(0, index), effectKind: effectKind(row), outboxId: msgId };
        }
    }
    const crdt = /^crdt:(.+):(reply|fanout)$/.exec(msgId);
    if (row.ri_type_id === 'WS_OUTBOX' && crdt &&
        ((crdt[2] === 'reply' && envelope?.payload?.typeId === 'rallar.crdt.append-response.v1') ||
         (crdt[2] === 'fanout' && envelope?.payload?.typeId === 'rallar.crdt.update.v1'))) {
        return {
            commandId: crdt[1],
            effectKind: crdt[2] === 'reply' ? 'crdt-append-reply' : 'crdt-update-fanout',
            outboxId: msgId,
        };
    }
    const admin = nestedEvidenceJson(envelope?.payload?.resource) as Record<string, unknown> | undefined;
    if (row.ri_type_id === 'APP_OUTBOX' && row.ri_topic_id === 'rallar.admin.prune-expired' &&
        envelope?.payload?.typeId === 'ADMIN_PRUNE_EXPIRED' && admin?.kind === 'page' &&
        typeof admin.jobId === 'string' && typeof admin.category === 'string' &&
        envelope.route?.contextId === admin.jobId) {
        return { commandId: admin.jobId, effectKind: 'admin-prune-page', outboxId: msgId };
    }
    return undefined;
}

function effectKind(row: OutboxRow): string {
    if (row.ri_topic_id === 'app-outbox.group-presence-summary') return 'group-presence-summary';
    if (row.ri_topic_id === 'app-outbox.rtc-topology') return 'rtc-topology-recompute';
    if (row.ri_type_id === 'WS_OUTBOX' && row.ri_topic_id === 'client-state.snapshot') {
        return 'principal-state:snapshot';
    }
    if (row.ri_type_id === 'WS_OUTBOX' && row.ri_topic_id === 'client-state.event') {
        return 'principal-state:event';
    }
    return `${row.ri_type_id}:${row.ri_topic_id}`;
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function deriveApiV1StateWriteEvidence(
    spec: EvidenceSpec,
    rawRows: readonly InboxRow[],
    rawOutboxRows: readonly OutboxRow[] = [],
    intermediateMutationIntents: readonly Record<string, unknown>[] = [],
    overdueRecoveryFixture?: OverdueRecoveryEvidence,
): Record<string, unknown> {
    const selectedTypes = new Set(spec.commandTypes ?? []);
    const selectedPrefixes = spec.commandIdPrefixes ?? [];
    const appInbox = rawRows.map(parseRow).filter((row) =>
        (selectedTypes.size === 0 || selectedTypes.has(row.commandType)) &&
        (selectedPrefixes.length === 0 || row.commandIds.some((id) =>
            selectedPrefixes.some((prefix) => id.startsWith(prefix))))
    );
    const statusResultFailures = appInbox.filter((row) =>
        (row.status === 'COMPLETED' && row.resultStatus !== 'COMPLETED') ||
        (row.status === 'FAILED' && row.resultStatus !== 'FAILED') ||
        !['COMPLETED', 'FAILED'].includes(row.status) ||
        !row.durableResultValid
    ).length;
    const inboxByCommandId = new Map(appInbox.flatMap((row) =>
        row.commandIds.map((commandId) => [commandId, row] as const)
    ));
    const linkedOutbox = rawOutboxRows.flatMap((row) => {
        const canonical = canonicalEffect(row);
        if (!canonical) return [];
        const command = inboxByCommandId.get(canonical.commandId);
        if (!command) return [];
        return [{
            resourceId: row.ri_resource_id, outboxId: canonical.outboxId,
            topicId: row.ri_topic_id,
            typeId: row.ri_type_id, status: row.ri_status,
            commandId: canonical.commandId, appInboxResourceId: command.resourceId,
            effectKind: canonical.effectKind,
            stage: canonical.effectKind === 'rtc-topology-recompute' &&
                command.commandType.startsWith('GROUP_') ? 'downstream' : 'direct',
        }];
    });
    const resourceOutbox = linkedOutbox.filter((effect) => effect.stage === 'direct');
    const downstreamOutbox = linkedOutbox.filter((effect) => effect.stage === 'downstream');
    const effectFailures = appInbox.filter((row) => {
        const expected = spec.expectedEffectsByCommandType?.[row.commandType];
        if (!expected || row.status !== 'COMPLETED') return false;
        const effects = resourceOutbox.filter((effect) => effect.appInboxResourceId === row.resourceId);
        const actual = effects.map((effect) => effect.effectKind);
        const receiptIds = row.receipt?.outboxIds;
        return !sameMultiset(expected, actual) ||
            (receiptIds !== undefined && !sameMultiset(
                receiptIds,
                effects.map((effect) => row.receipt?.identityKind === 'logical-msg-id'
                    ? effect.outboxId : effect.resourceId),
            ));
    });
    const naturalBoundedRetries = appInbox.filter((row) =>
        row.status === 'COMPLETED' && row.resultStatus === 'COMPLETED' &&
        row.attempts >= 2 && row.attempts <= 5
    );
    const completedCount = appInbox.filter((row) => row.status === 'COMPLETED').length;
    const evidenceLimit = Math.max(0, Math.min(25, Math.trunc(spec.evidenceSampleLimit ?? 25)));
    const receiptOutboxIds = [...new Set(appInbox.flatMap((row) => row.outboxIds))].sort();
    return {
        source: 'postgres.resource_inbox+resource_inbox_results',
        selector: { match: spec.match, commandTypes: [...selectedTypes].sort(), commandIdPrefixes: selectedPrefixes },
        matchedAppInboxCount: appInbox.length,
        completedAppInboxCount: completedCount,
        failedAppInboxCount: appInbox.filter((row) => row.status === 'FAILED').length,
        completedAppInboxStatus: appInbox.length > 0 && completedCount === appInbox.length
            ? 'COMPLETED' : 'MIXED',
        atomicCompletionFailures: statusResultFailures + effectFailures.length,
        statusResultFailures,
        finalEffectFailureCount: effectFailures.length,
        finalEffectFailures: effectFailures.slice(0, evidenceLimit).map((row) => row.resourceId),
        finalEffectFailureEvidenceTruncated: effectFailures.length > evidenceLimit,
        intermediateMutationIntents,
        appInbox: appInbox.slice(0, evidenceLimit),
        appInboxEvidenceTruncated: appInbox.length > evidenceLimit,
        receiptOutboxIdCount: receiptOutboxIds.length,
        receiptOutboxIds: receiptOutboxIds.slice(0, evidenceLimit),
        resourceOutboxCount: resourceOutbox.length,
        resourceOutbox: resourceOutbox.slice(0, evidenceLimit),
        resourceOutboxEvidenceTruncated: resourceOutbox.length > evidenceLimit,
        downstreamLinkedOutboxCount: downstreamOutbox.length,
        naturalBoundedRetryCount: naturalBoundedRetries.length,
        naturalBoundedRetries: naturalBoundedRetries.slice(0, evidenceLimit),
        naturalBoundedRetryObserved: naturalBoundedRetries.length > 0,
        naturalRetryEvidenceGap: naturalBoundedRetries.length === 0,
        ...(overdueRecoveryFixture ? { overdueRecoveryFixture } : {}),
    };
}

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
          and position(${match} in i.ri_resource) > 0
        order by i.ri_row_id
    `;
}

async function readIntermediateIntents(
    sql: Sql,
    match: string,
): Promise<readonly Record<string, unknown>[]> {
    return await sql<Record<string, unknown>[]>`
        select ri_resource_id as "resourceId", ri_topic_id as "topicId",
               ri_type_id as "typeId", ri_status as status
        from resource_inbox
        where position(${match} in ri_resource) > 0
          and (ri_type_id ilike '%INTENT%' or ri_topic_id ilike '%intent%'
               or ri_resource ilike '%mutationIntent%')
        order by ri_row_id
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
    fixture: NonNullable<EvidenceSpec['overdueRecoveryFixture']>,
): Promise<OverdueRecoveryEvidence> {
    const parsed = rows.map(parseRow);
    const commandIdPrefix = fixture.commandIdPrefix;
    const selected = parsed.find((row) =>
        row.status === 'COMPLETED' && row.resultStatus === 'COMPLETED' &&
        (!commandIdPrefix || row.commandIds.some((id) => id.startsWith(commandIdPrefix))) &&
        (!fixture.commandType || row.commandType === fixture.commandType)
    );
    if (!selected) throw new Error('No completed AppInbox row is available for the overdue fairness fixture.');
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
    const after = parseRow(afterRaw);
    const claimedAt = after.startAt ? new Date(after.startAt) : new Date(0);
    const dueAgeAtClaimMs = claimedAt.getTime() - dueAt.getTime();
    return {
        fixtureKind: 'isolated-overdue-reschedule', mutatesCompletionHistory: true,
        resourceId: selected.resourceId, commandType: selected.commandType,
        beforeStatus: selected.status, beforeAttempts: selected.attempts,
        injectedDueAt: dueAt.toISOString(), overdueByMs,
        afterStatus: after.status, afterResultStatus: after.resultStatus,
        afterAttempts: after.attempts, claimedAt: claimedAt.toISOString(),
        dueAgeAtClaimMs, notBeforeSatisfied: dueAgeAtClaimMs >= 0,
        overdueAtClaim: dueAgeAtClaimMs >= 30_000,
        recovered: after.status === 'COMPLETED' && after.resultStatus === 'COMPLETED',
    };
}

export async function collectApiV1StateWriteEvidence(
    input: unknown,
    databaseUrl = process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
): Promise<Record<string, unknown>> {
    const spec = input as EvidenceSpec;
    if (!spec || typeof spec.match !== 'string' || spec.match.length === 0) {
        throw new Error('stateWriteEvidence.match must be a non-empty string.');
    }
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        const rows = await readRows(sql, spec.match);
        const minimum = spec.minimumMatchedRows ?? 1;
        const matching = rows.map(parseRow).filter((row) =>
            (!spec.commandTypes?.length || spec.commandTypes.includes(row.commandType)) &&
            (!spec.commandIdPrefixes?.length || row.commandIds.some((id) =>
                spec.commandIdPrefixes?.some((prefix) => id.startsWith(prefix))))
        );
        if (matching.length < minimum) {
            throw new Error(`Expected at least ${minimum} matching AppInbox rows; found ${matching.length}.`);
        }
        const intermediate = await readIntermediateIntents(sql, spec.match);
        const overdueRecovery = spec.overdueRecoveryFixture
            ? await runOverdueRecoveryFixture(sql, rows, spec.overdueRecoveryFixture)
            : undefined;
        const finalRows = overdueRecovery ? await readRows(sql, spec.match) : rows;
        const outboxRows = await readOutboxRows(sql, spec.match);
        return deriveApiV1StateWriteEvidence(spec, finalRows, outboxRows, intermediate, overdueRecovery);
    } finally {
        await sql.end({ timeout: 5 });
    }
}
