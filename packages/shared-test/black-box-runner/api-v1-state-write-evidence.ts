import {
  collectEvidenceNamedStrings,
  nestedEvidenceJson,
  parseEvidenceJson,
} from './api-v1-state-write-json-evidence.ts';
import {
  type ReceiptEffectIdentityKind,
  validatePersistedAppInboxResult,
} from './api-v1-state-write-result-evidence.ts';
import {
  readPersistedCommandEvidence,
  type PersistedCommandEvidence,
} from './api-v1-state-write-receipt-evidence.ts';
import { collectApiV1StateWriteEvidenceFromSql } from './api-v1-state-write-evidence-sql.ts';
export { collectApiV1StateWriteEvidence } from './api-v1-state-write-evidence-source.ts';
export { collectApiV1StateWriteEvidenceFromSql };
export type ApiV1StateWriteEvidenceSpec = Readonly<{
  match: string;
  commandTypes?: readonly string[];
  commandIdPrefixes?: readonly string[];
  minimumMatchedRows?: number;
  evidenceSampleLimit?: number;
  expectedEffectsByCommandType?: Readonly<Record<string, readonly string[]>>;
  overdueRecoveryFixture?: Readonly<{
    commandType?: string;
    commandIdPrefix?: string;
    overdueByMs?: number;
    timeoutMs?: number;
  }>;
}>;
export type OutboxRow = Readonly<{
  ri_resource_id: string;
  ri_topic_id: string;
  ri_type_id: string;
  ri_status: string;
  ri_resource: string;
}>;
export type InboxRow = Readonly<{
  ri_row_id: number | string;
  ri_resource_id: string;
  ri_topic_id: string;
  fk_ext_bank_id: string;
  ri_resource: string;
  ri_status: string;
  ri_attempts: number | string;
  start_ts: Date | string | null;
  end_ts: Date | string | null;
  next_ts: Date | string | null;
  result_status: string | null;
  result_resource: string | null;
}>;
export type ParsedInboxRow = Readonly<{
  rowId: number;
  resourceId: string;
  topicId: string;
  contextId: string;
  commandType: string;
  commandIds: readonly string[];
  status: string;
  resultStatus: string;
  attempts: number;
  startAt: string | null;
  endAt: string | null;
  nextAt: string | null;
  outboxIds: readonly string[];
  durableResult: unknown;
  durableResultValid: boolean;
  durableResultFailure?: string;
  receipt?: Readonly<{
    commandId: string;
    outboxIds: readonly string[];
    identityKind: ReceiptEffectIdentityKind;
  }>;
}>;
export type OverdueRecoveryEvidence = Readonly<{
  fixtureKind: 'isolated-overdue-reschedule';
  mutatesCompletionHistory: true;
  resourceId: string;
  commandType: string;
  beforeStatus: string;
  beforeAttempts: number;
  injectedDueAt: string;
  overdueByMs: number;
  afterStatus: string;
  afterResultStatus: string;
  afterAttempts: number;
  claimedAt: string;
  dueAgeAtClaimMs: number;
  notBeforeSatisfied: boolean;
  overdueAtClaim: boolean;
  recovered: boolean;
}>;

export function parseApiV1StateWriteEvidenceRow(
  row: InboxRow,
  commandEvidence?: PersistedCommandEvidence,
): ParsedInboxRow {
  const envelope = parseEvidenceJson(row.ri_resource) as
    { payload?: { typeId?: unknown } } | undefined;
  const commandType =
    commandEvidence?.commandType ??
    (typeof envelope?.payload?.typeId === 'string' ? envelope.payload.typeId : 'UNKNOWN');
  const commandIds = new Set(commandEvidence?.commandIds ?? []);
  if (!commandEvidence)
    collectEvidenceNamedStrings(
      envelope,
      new Set(['commandId', 'deliveryId', 'jobId', 'requestId', 'updateId']),
      commandIds,
    );
  const resultEvidence = validatePersistedAppInboxResult({
    commandType,
    commandIds: [...commandIds],
    resultStatus: row.result_status ?? 'MISSING',
    resultResource: row.result_resource,
    authoritativeReceipt: commandEvidence?.receipt,
    commandScope: commandEvidence?.commandScope,
    requireAuthoritativeReceipt: commandEvidence !== undefined,
  });
  const iso = (value: Date | string | null): string | null =>
    value ? new Date(value).toISOString() : null;
  return {
    rowId: Number(row.ri_row_id),
    resourceId: row.ri_resource_id,
    topicId: row.ri_topic_id,
    contextId: row.fk_ext_bank_id,
    commandType,
    commandIds: [...commandIds].sort(),
    status: row.ri_status,
    resultStatus: row.result_status ?? 'MISSING',
    attempts: Number(row.ri_attempts),
    startAt: iso(row.start_ts),
    endAt: iso(row.end_ts),
    nextAt: iso(row.next_ts),
    outboxIds: [...(resultEvidence.receipt?.outboxIds ?? [])].sort(),
    durableResult: resultEvidence.result,
    durableResultValid: resultEvidence.valid && (commandEvidence?.valid ?? true),
    ...((commandEvidence?.failure ?? resultEvidence.failure)
      ? {
          durableResultFailure: commandEvidence?.failure ?? resultEvidence.failure,
        }
      : {}),
    ...(resultEvidence.receipt ? { receipt: resultEvidence.receipt } : {}),
  };
}

function canonicalEffect(row: OutboxRow):
  | Readonly<{
      commandId: string;
      effectKind: string;
      outboxId: string;
    }>
  | undefined {
  const envelope = parseEvidenceJson(row.ri_resource) as
    | {
        id?: { msgId?: unknown };
        route?: { contextId?: unknown };
        payload?: { typeId?: unknown; resource?: unknown };
      }
    | undefined;
  const msgId = envelope?.id?.msgId;
  if (typeof msgId !== 'string') return undefined;
  for (const marker of [
    ':rtc-topology-recompute:',
    ':group-presence-summary:',
    ':principal-state:',
  ]) {
    const index = msgId.indexOf(marker);
    if (index > 0) {
      return { commandId: msgId.slice(0, index), effectKind: effectKind(row), outboxId: msgId };
    }
  }
  const crdt = /^crdt:(.+):(reply|fanout)$/.exec(msgId);
  if (
    row.ri_type_id === 'WS_OUTBOX' &&
    crdt &&
    ((crdt[2] === 'reply' && envelope?.payload?.typeId === 'rallar.crdt.append-response.v1') ||
      (crdt[2] === 'fanout' && envelope?.payload?.typeId === 'rallar.crdt.update.v1'))
  ) {
    return {
      commandId: crdt[1],
      effectKind: crdt[2] === 'reply' ? 'crdt-append-reply' : 'crdt-update-fanout',
      outboxId: msgId,
    };
  }
  const admin = nestedEvidenceJson(envelope?.payload?.resource) as
    Record<string, unknown> | undefined;
  if (
    row.ri_type_id === 'APP_OUTBOX' &&
    row.ri_topic_id === 'rallar.admin.prune-expired' &&
    envelope?.payload?.typeId === 'ADMIN_PRUNE_EXPIRED' &&
    admin?.kind === 'page' &&
    typeof admin.jobId === 'string' &&
    typeof admin.category === 'string' &&
    envelope.route?.contextId === admin.jobId
  ) {
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
  spec: ApiV1StateWriteEvidenceSpec,
  rawRows: readonly InboxRow[],
  rawOutboxRows: readonly OutboxRow[] = [],
  intermediateMutationIntents: readonly Record<string, unknown>[] = [],
  overdueRecoveryFixture?: OverdueRecoveryEvidence,
  commandEvidence: readonly PersistedCommandEvidence[] = [],
): Record<string, unknown> {
  const selectedTypes = new Set(spec.commandTypes ?? []);
  const selectedPrefixes = spec.commandIdPrefixes ?? [];
  const commandEvidenceByResourceId = new Map(
    commandEvidence.map((entry) => [entry.appInboxResourceId, entry] as const),
  );
  const appInbox = rawRows
    .map((row) =>
      parseApiV1StateWriteEvidenceRow(row, commandEvidenceByResourceId.get(row.ri_resource_id)),
    )
    .filter(
      (row) =>
        (selectedTypes.size === 0 || selectedTypes.has(row.commandType)) &&
        (selectedPrefixes.length === 0 ||
          row.commandIds.some((id) => selectedPrefixes.some((prefix) => id.startsWith(prefix)))),
    );
  const statusResultFailures = appInbox.filter(
    (row) =>
      (row.status === 'COMPLETED' && row.resultStatus !== 'COMPLETED') ||
      (row.status === 'FAILED' && row.resultStatus !== 'FAILED') ||
      !['COMPLETED', 'FAILED'].includes(row.status) ||
      !row.durableResultValid,
  ).length;
  const inboxByCommandId = new Map(
    appInbox.flatMap((row) => row.commandIds.map((commandId) => [commandId, row] as const)),
  );
  const linkedOutbox = rawOutboxRows.flatMap((row) => {
    const canonical = canonicalEffect(row);
    if (!canonical) return [];
    const command = inboxByCommandId.get(canonical.commandId);
    if (!command) return [];
    return [
      {
        resourceId: row.ri_resource_id,
        outboxId: canonical.outboxId,
        topicId: row.ri_topic_id,
        typeId: row.ri_type_id,
        status: row.ri_status,
        commandId: canonical.commandId,
        appInboxResourceId: command.resourceId,
        effectKind: canonical.effectKind,
        stage:
          canonical.effectKind === 'rtc-topology-recompute' &&
          command.commandType.startsWith('GROUP_')
            ? 'downstream'
            : 'direct',
      },
    ];
  });
  const resourceOutbox = linkedOutbox.filter((effect) => effect.stage === 'direct');
  const downstreamOutbox = linkedOutbox.filter((effect) => effect.stage === 'downstream');
  const effectFailures = appInbox.filter((row) => {
    const expected = spec.expectedEffectsByCommandType?.[row.commandType];
    if (!expected || row.status !== 'COMPLETED') return false;
    const effects = resourceOutbox.filter((effect) => effect.appInboxResourceId === row.resourceId);
    const actual = effects.map((effect) => effect.effectKind);
    const receiptIds = row.receipt?.outboxIds;
    return (
      !sameMultiset(expected, actual) ||
      (receiptIds !== undefined &&
        !sameMultiset(
          receiptIds,
          effects.map((effect) =>
            row.receipt?.identityKind === 'logical-msg-id' ? effect.outboxId : effect.resourceId,
          ),
        ))
    );
  });
  const naturalBoundedRetries = appInbox.filter(
    (row) =>
      row.status === 'COMPLETED' &&
      row.resultStatus === 'COMPLETED' &&
      row.attempts >= 2 &&
      row.attempts <= 5,
  );
  const completedCount = appInbox.filter((row) => row.status === 'COMPLETED').length;
  const evidenceLimit = Math.max(0, Math.min(25, Math.trunc(spec.evidenceSampleLimit ?? 25)));
  const receiptOutboxIds = [...new Set(appInbox.flatMap((row) => row.outboxIds))].sort();
  return {
    source: 'postgres.resource_inbox+resource_inbox_results',
    selector: {
      match: spec.match,
      commandTypes: [...selectedTypes].sort(),
      commandIdPrefixes: selectedPrefixes,
    },
    matchedAppInboxCount: appInbox.length,
    completedAppInboxCount: completedCount,
    failedAppInboxCount: appInbox.filter((row) => row.status === 'FAILED').length,
    completedAppInboxStatus:
      appInbox.length > 0 && completedCount === appInbox.length ? 'COMPLETED' : 'MIXED',
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
