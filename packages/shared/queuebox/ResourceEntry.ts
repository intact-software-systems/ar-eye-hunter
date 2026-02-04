export type Key = {
    readonly topicId: string
    readonly resourceId: string
    readonly contextId: string
}

export enum EntityStatus {
    NEW = "NEW",
    RETRY = "RETRY",
    RESERVED = "RESERVED",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED",
    ABORTED = "ABORTED",
    NON_RETRYABLE = "NON_RETRYABLE",
    PARTITIONED = "PARTITIONED",
    MERGED = "MERGED"
}

export type Audit = {
    readonly date: Temporal.PlainTime
    readonly createdBy: string
    readonly createdTs: Temporal.PlainDateTime
}

export type DequeueAudit = {
    readonly startTs?: Temporal.Instant
    readonly endTs?: Temporal.Instant
    readonly nextTs?: Temporal.Instant
    readonly attempts: number | 0
}

export type Db = {
    readonly id: string
}

export type ResourceEntry = {
    readonly key: Key
    readonly resource: string
    readonly typeId: string
    readonly audit: Audit
    status: EntityStatus
    dequeueAudit: DequeueAudit
    readonly db?: Db
}


export const NOT_COMPLETED_STATUSES: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.NEW,
    EntityStatus.RETRY,
    EntityStatus.RESERVED,
    EntityStatus.FAILED,
    EntityStatus.ABORTED,
    EntityStatus.NON_RETRYABLE,
]);

export const NOT_COMPLETED_STATUSES_EXCEPT_NEW: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.RETRY,
    EntityStatus.RESERVED,
    EntityStatus.FAILED,
    EntityStatus.ABORTED,
    EntityStatus.NON_RETRYABLE,
]);

export const NOT_COMPLETED_RETRYABLE_STATUSES: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.NEW,
    EntityStatus.RETRY,
    EntityStatus.RESERVED,
]);

export const NEW_AND_RETRY_STATUSES: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.NEW,
    EntityStatus.RETRY,
]);

export const FAILED_STATUS: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.FAILED,
]);

export const NOT_COMPLETED_RETRYABLE_INCLUDING_FAILED_STATUSES: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.NEW,
    EntityStatus.RETRY,
    EntityStatus.RESERVED,
    EntityStatus.FAILED,
]);

export const COMPLETED_STATUSES: ReadonlySet<EntityStatus> = new Set([
    EntityStatus.COMPLETED,
    EntityStatus.PARTITIONED,
    EntityStatus.MERGED,
]);

// Note: Not being actively retried
export function isFailed(status: EntityStatus): boolean {
    return (
        status === EntityStatus.FAILED ||
        status === EntityStatus.NON_RETRYABLE ||
        status === EntityStatus.ABORTED
    );
}

export function isCompleted(status: EntityStatus): boolean {
    return COMPLETED_STATUSES.has(status);
}

export const TIMEOUT_ON_NON_RESPONSIVE_ENTRY: Temporal.Duration = Temporal.Duration.from({minutes: 5});
