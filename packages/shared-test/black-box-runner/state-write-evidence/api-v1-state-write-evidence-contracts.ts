import { type ReceiptEffectIdentityKind } from './api-v1-state-write-result-evidence.ts';

export type ApiV1StateWriteEvidence = Readonly<Record<string, unknown>>;

export type ApiV1StateWriteEvidenceSqlParameter = string | number | boolean | Date | null;

export interface ApiV1StateWriteEvidenceQuery {
    <Rows extends readonly (object | undefined)[]>(
        strings: TemplateStringsArray,
        ...values: readonly ApiV1StateWriteEvidenceSqlParameter[]
    ): Promise<Rows>;
}

export interface ApiV1StateWriteEvidenceSql extends ApiV1StateWriteEvidenceQuery {
    begin(write: (sql: ApiV1StateWriteEvidenceQuery) => Promise<void>): Promise<void>;
}

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
    fk_ext_bank_id: string;
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
