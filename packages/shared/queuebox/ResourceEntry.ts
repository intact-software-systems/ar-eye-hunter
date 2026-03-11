export type Key = {
    readonly topicId: string
    readonly resourceId: string
    readonly contextId: string
}

export type ResourceEntryKeyString = string

export function toKeyAsString(key: Key): string {
    return `${key.topicId}/${key.resourceId}/${key.contextId}`;
}

export function toResourceEntryKey(keyAsString: string): Key {
    const [topicId, resourceId, contextId] = keyAsString.split('/');
    return { topicId, resourceId, contextId };
}

export function isKeysEqual(key1: Key, key2: Key): boolean {
    return (
        key1.topicId === key2.topicId &&
        key1.resourceId === key2.resourceId &&
        key1.contextId === key2.contextId
    );
}

export enum EntityStatus {
    NEW = 'NEW',
    RETRY = 'RETRY',
    RESERVED = 'RESERVED',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    ABORTED = 'ABORTED',
    NON_RETRYABLE = 'NON_RETRYABLE',
    PARTITIONED = 'PARTITIONED',
    MERGED = 'MERGED'
}

export type Audit = {
    readonly date: Temporal.PlainTime
    readonly createdBy: string
    readonly createdTs: Temporal.PlainDateTime
    readonly expiryTs: Temporal.Instant
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

export const TIMEOUT_ON_NON_RESPONSIVE_ENTRY: Temporal.Duration = Temporal.Duration.from({ minutes: 5 });
export const NEVER_EXPIRE_TS = Temporal.Instant.from('9999-12-31T23:59:59.999Z');

export function isExpiredAudit(
    audit: Audit,
    now: Temporal.Instant = Temporal.Now.instant(),
): boolean {
    return Temporal.Instant.compare(now, audit.expiryTs) >= 0;
}

export function isExpiredResourceEntry(
    entry: ResourceEntry,
    now: Temporal.Instant = Temporal.Now.instant(),
): boolean {
    return isExpiredAudit(entry.audit, now);
}

export function toResourceEntry<T>(
    typeId: string,
    resource: T,
    expiryTs: Temporal.Instant = NEVER_EXPIRE_TS,
): ResourceEntry {
    return {
        key: {
            topicId: typeId,
            resourceId: crypto.randomUUID().toString(),
            contextId: 'test'
        },
        resource: JSON.stringify(resource),
        typeId: typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs,
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        },
        db: undefined
    };
}

export function toResourceEntryWithKey<T>(
    key: Key,
    typeId: string,
    resource: T,
    expiryTs: Temporal.Instant = NEVER_EXPIRE_TS,
): ResourceEntry {
    return {
        key: key,
        resource: JSON.stringify(resource),
        typeId: typeId,
        audit: {
            date: Temporal.Now.plainTimeISO(),
            createdBy: 'test',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs,
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        },
        db: undefined
    };
}


export function toUpdatedResourceEntry(
    entry: ResourceEntry,
    entityStatus: EntityStatus,
    endTimestamp: Temporal.Instant,
    nextTimestamp?: Temporal.Instant
): ResourceEntry {
    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: entry.audit,
        status: entityStatus,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs,
            endTs: endTimestamp,
            nextTs: nextTimestamp,
            attempts: entry.dequeueAudit.attempts,
        },
        db: entry.db
    };
}
