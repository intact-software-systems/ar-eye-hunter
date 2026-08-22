import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    type ApiV1StateWriteEvidence,
    type ApiV1StateWriteEvidenceSpec,
    type InboxRow,
    type OutboxRow,
    type OverdueRecoveryEvidence,
    type ParsedInboxRow
} from './api-v1-state-write-evidence-contracts.ts';
import {
    collectEvidenceNamedStrings,
    nestedEvidenceJson,
    parseEvidenceJson
} from './api-v1-state-write-json-evidence.ts';
import { readPersistedCommandEvidence, type PersistedCommandEvidence } from './api-v1-state-write-receipt-evidence.ts';
import { validatePersistedAppInboxResult } from './api-v1-state-write-result-evidence.ts';

type ParsedEvidenceValue = ReturnType<typeof parseEvidenceJson>;

export function parseApiV1StateWriteEvidenceRow(
    row: InboxRow,
    commandEvidence?: PersistedCommandEvidence
): ParsedInboxRow {
    const envelope = parseEvidenceJson(row.ri_resource) as { payload?: { typeId?: ParsedEvidenceValue; }; } | undefined;
    const commandType = commandEvidence?.commandType ??
        (typeof envelope?.payload?.typeId === 'string' ? envelope.payload.typeId : 'UNKNOWN');
    const commandIds = new Set(commandEvidence?.commandIds ?? []);
    if (!commandEvidence) {
        collectEvidenceNamedStrings(
            envelope,
            new Set(['commandId', 'deliveryId', 'jobId', 'requestId', 'updateId']),
            commandIds
        );
    }
    const resultEvidence = validatePersistedAppInboxResult({
        commandType,
        commandIds: [...commandIds],
        resultStatus: row.result_status ?? 'MISSING',
        resultResource: row.result_resource,
        authoritativeReceipt: commandEvidence?.receipt,
        commandScope: commandEvidence?.commandScope,
        requireAuthoritativeReceipt: commandEvidence !== undefined
    });
    const iso = (value: Date | string | null): string | null => value ? new Date(value).toISOString() : null;
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
                durableResultFailure: commandEvidence?.failure ?? resultEvidence.failure
            }
            : {}),
        ...(resultEvidence.receipt ? { receipt: resultEvidence.receipt } : {})
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
            id?: { msgId?: ParsedEvidenceValue; };
            route?: { contextId?: ParsedEvidenceValue; };
            payload?: { typeId?: ParsedEvidenceValue; resource?: ParsedEvidenceValue; };
        }
        | undefined;
    const msgId = envelope?.id?.msgId;
    if (typeof msgId !== 'string') {
        return undefined;
    }
    for (
        const marker of [
            ':rtc-topology-recompute:',
            ':group-presence-summary:',
            ':principal-state:'
        ]
    ) {
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
            outboxId: msgId
        };
    }
    const admin = nestedEvidenceJson(envelope?.payload?.resource) as Record<string, unknown> | undefined;
    if (
        row.ri_type_id === 'APP_OUTBOX' &&
        row.ri_topic_id === 'rallar.admin.prune-expired' &&
        envelope?.payload?.typeId === 'ADMIN_PRUNE_EXPIRED' &&
        admin?.kind === 'page' &&
        typeof admin.jobId === 'string' &&
        typeof admin.category === 'string' &&
        envelope.route?.contextId === toAppQueueKey({
                topicId: row.ri_topic_id,
                resourceId: msgId,
                contextId: admin.jobId
            }).contextId
    ) {
        return { commandId: admin.jobId, effectKind: 'admin-prune-page', outboxId: msgId };
    }
    return undefined;
}

function effectKind(row: OutboxRow): string {
    if (row.ri_topic_id === 'app-outbox.group-presence-summary') {
        return 'group-presence-summary';
    }
    if (row.ri_topic_id === 'app-outbox.rtc-topology') {
        return 'rtc-topology-recompute';
    }
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

type LinkedOutboxEvidence = Readonly<{
    resourceId: string;
    outboxId: string;
    topicId: string;
    typeId: string;
    status: string;
    commandId: string;
    appInboxResourceId: string;
    appInboxTopicId: string;
    appInboxContextId: string;
    effectKind: string;
    stage: 'direct' | 'downstream';
}>;

interface DerivedEvidenceResultInput {
    readonly spec: ApiV1StateWriteEvidenceSpec;
    readonly selectedTypes: ReadonlySet<string>;
    readonly selectedPrefixes: readonly string[];
    readonly appInbox: readonly ParsedInboxRow[];
    readonly statusResultFailures: number;
    readonly resourceOutbox: readonly LinkedOutboxEvidence[];
    readonly downstreamOutbox: readonly LinkedOutboxEvidence[];
    readonly effectFailures: readonly ParsedInboxRow[];
    readonly intermediateMutationIntents: readonly Record<string, unknown>[];
    readonly overdueRecoveryFixture?: OverdueRecoveryEvidence;
}

export function deriveApiV1StateWriteEvidence(
    spec: ApiV1StateWriteEvidenceSpec,
    rawRows: readonly InboxRow[],
    rawOutboxRows: readonly OutboxRow[] = [],
    intermediateMutationIntents: readonly Record<string, unknown>[] = [],
    overdueRecoveryFixture?: OverdueRecoveryEvidence,
    commandEvidence: readonly PersistedCommandEvidence[] = []
): ApiV1StateWriteEvidence {
    const selectedTypes = new Set(spec.commandTypes ?? []);
    const selectedPrefixes = spec.commandIdPrefixes ?? [];
    const appInbox = selectAppInboxEvidence({
        rawRows,
        commandEvidence,
        selectedTypes,
        selectedPrefixes
    });
    const statusResultFailures = appInbox.filter(
        (row) =>
            (row.status === 'COMPLETED' && row.resultStatus !== 'COMPLETED') ||
            (row.status === 'FAILED' && row.resultStatus !== 'FAILED') ||
            !['COMPLETED', 'FAILED'].includes(row.status) ||
            !row.durableResultValid
    ).length;
    const linkedOutbox = linkOutboxEvidence(appInbox, rawOutboxRows);
    const resourceOutbox = linkedOutbox.filter((effect) => effect.stage === 'direct');
    const downstreamOutbox = linkedOutbox.filter((effect) => effect.stage === 'downstream');
    const effectFailures = appInbox.filter((row) => {
        const expected = spec.expectedEffectsByCommandType?.[row.commandType];
        if (!expected || row.status !== 'COMPLETED') {
            return false;
        }
        const effects = resourceOutbox.filter((effect) =>
            effect.appInboxResourceId === row.resourceId &&
            effect.appInboxTopicId === row.topicId &&
            effect.appInboxContextId === row.contextId
        );
        const actual = effects.map((effect) => effect.effectKind);
        const receiptIds = row.receipt?.outboxIds;
        return (
            !sameMultiset(expected, actual) ||
            (receiptIds !== undefined &&
                !sameMultiset(
                    receiptIds,
                    effects.map((effect) =>
                        row.receipt?.identityKind === 'logical-msg-id' ? effect.outboxId : effect.resourceId
                    )
                ))
        );
    });
    return createDerivedEvidenceResult({
        spec,
        selectedTypes,
        selectedPrefixes,
        appInbox,
        statusResultFailures,
        resourceOutbox,
        downstreamOutbox,
        effectFailures,
        intermediateMutationIntents,
        overdueRecoveryFixture
    });
}

function createDerivedEvidenceResult(input: DerivedEvidenceResultInput): ApiV1StateWriteEvidence {
    const naturalBoundedRetries = input.appInbox.filter(
        (row) =>
            row.status === 'COMPLETED' &&
            row.resultStatus === 'COMPLETED' &&
            row.attempts >= 2 &&
            row.attempts <= 5
    );
    const completedCount = input.appInbox.filter((row) => row.status === 'COMPLETED').length;
    const evidenceLimit = Math.max(0, Math.min(25, Math.trunc(input.spec.evidenceSampleLimit ?? 25)));
    const receiptOutboxIds = [...new Set(input.appInbox.flatMap((row) => row.outboxIds))].sort();
    return {
        source: 'postgres.resource_inbox+resource_inbox_results',
        selector: {
            match: input.spec.match,
            commandTypes: [...input.selectedTypes].sort(),
            commandIdPrefixes: input.selectedPrefixes
        },
        matchedAppInboxCount: input.appInbox.length,
        completedAppInboxCount: completedCount,
        failedAppInboxCount: input.appInbox.filter((row) => row.status === 'FAILED').length,
        completedAppInboxStatus: input.appInbox.length > 0 && completedCount === input.appInbox.length
            ? 'COMPLETED'
            : 'MIXED',
        atomicCompletionFailures: input.statusResultFailures + input.effectFailures.length,
        statusResultFailures: input.statusResultFailures,
        finalEffectFailureCount: input.effectFailures.length,
        finalEffectFailures: input.effectFailures.slice(0, evidenceLimit).map((row) => row.resourceId),
        finalEffectFailureEvidenceTruncated: input.effectFailures.length > evidenceLimit,
        intermediateMutationIntentCount: input.intermediateMutationIntents.length,
        intermediateMutationIntents: input.intermediateMutationIntents,
        appInbox: input.appInbox.slice(0, evidenceLimit),
        appInboxEvidenceTruncated: input.appInbox.length > evidenceLimit,
        receiptOutboxIdCount: receiptOutboxIds.length,
        receiptOutboxIds: receiptOutboxIds.slice(0, evidenceLimit),
        resourceOutboxCount: input.resourceOutbox.length,
        resourceOutbox: input.resourceOutbox.slice(0, evidenceLimit),
        resourceOutboxEvidenceTruncated: input.resourceOutbox.length > evidenceLimit,
        downstreamLinkedOutboxCount: input.downstreamOutbox.length,
        naturalBoundedRetryCount: naturalBoundedRetries.length,
        naturalBoundedRetries: naturalBoundedRetries.slice(0, evidenceLimit),
        naturalBoundedRetryObserved: naturalBoundedRetries.length > 0,
        naturalRetryEvidenceGap: naturalBoundedRetries.length === 0,
        ...(input.overdueRecoveryFixture
            ? { overdueRecoveryFixture: input.overdueRecoveryFixture }
            : {})
    };
}

interface SelectAppInboxEvidenceInput {
    readonly rawRows: readonly InboxRow[];
    readonly commandEvidence: readonly PersistedCommandEvidence[];
    readonly selectedTypes: ReadonlySet<string>;
    readonly selectedPrefixes: readonly string[];
}

function selectAppInboxEvidence({
    rawRows,
    commandEvidence,
    selectedTypes,
    selectedPrefixes
}: SelectAppInboxEvidenceInput): readonly ParsedInboxRow[] {
    return rawRows
        .map((row, index) => parseApiV1StateWriteEvidenceRow(row, commandEvidence[index]))
        .filter(
            (row) =>
                (selectedTypes.size === 0 || selectedTypes.has(row.commandType)) &&
                (selectedPrefixes.length === 0 ||
                    row.commandIds.some((id) => selectedPrefixes.some((prefix) => id.startsWith(prefix))))
        );
}

function linkOutboxEvidence(
    appInbox: readonly ParsedInboxRow[],
    rawOutboxRows: readonly OutboxRow[]
): readonly LinkedOutboxEvidence[] {
    const inboxByCommandId = new Map(
        appInbox.flatMap((row) => row.commandIds.map((commandId) => [commandId, row] as const))
    );
    return rawOutboxRows.flatMap((row) => {
        const canonical = canonicalEffect(row);
        if (!canonical) {
            return [];
        }
        const command = inboxByCommandId.get(canonical.commandId);
        if (!command) {
            return [];
        }
        return [
            {
                resourceId: row.ri_resource_id,
                outboxId: canonical.outboxId,
                topicId: row.ri_topic_id,
                typeId: row.ri_type_id,
                status: row.ri_status,
                commandId: canonical.commandId,
                appInboxResourceId: command.resourceId,
                appInboxTopicId: command.topicId,
                appInboxContextId: command.contextId,
                effectKind: canonical.effectKind,
                stage: canonical.effectKind === 'rtc-topology-recompute' &&
                        command.commandType.startsWith('GROUP_')
                    ? 'downstream'
                    : 'direct'
            }
        ];
    });
}
