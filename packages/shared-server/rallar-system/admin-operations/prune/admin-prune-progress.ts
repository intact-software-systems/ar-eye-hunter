import { Temporal } from '@js-temporal/polyfill';
import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { ADMIN_PRUNE_EXPIRED_CATEGORIES } from '@shared/api/admin-operations-types.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { AdminPruneCommand } from '../inbox/admin-prune-command-codec.ts';
import type { AdminPrunePageWork } from './admin-prune-page-codec.ts';

export const ADMIN_PRUNE_AGGREGATE_TOPIC = 'admin-prune.aggregate';

export type AdminPruneCategoryResult = Readonly<{
    category: AdminPruneExpiredCategory;
    expiredRows: number;
    deletedRows: number;
    dryRun: false;
}>;

export type AdminPruneAggregate = Readonly<{
    version: 1;
    revision: number;
    jobId: string;
    generatedAtEpochMs: number;
    expireAtEpochMs: number;
    serverId: string;
    requestedBy: string;
    requestedSessionId: string;
    operation: 'maintenance.prune-expired';
    status: 'pending' | 'completed';
    changed: boolean;
    warnings: readonly [];
    completedCategories: readonly AdminPruneExpiredCategory[];
    results: readonly AdminPruneCategoryResult[];
}>;

export type AdminPruneCompletedResult = Readonly<{
    generatedAtEpochMs: number;
    serverId: string;
    warnings: readonly [];
    operation: 'maintenance.prune-expired';
    status: 'completed';
    changed: boolean;
    jobId: string;
    results: readonly AdminPruneCategoryResult[];
}>;

export interface AdminPrunePageProgress {
    readonly jobId: string;
    readonly category: AdminPruneExpiredCategory;
    readonly deletedRows: number;
    readonly next: AdminPrunePageWork | null;
}

export function createAdminPruneAggregate(
    input: Readonly<{
        jobId: string;
        generatedAtEpochMs: number;
        expireAtEpochMs: number;
        serverId: string;
        requestedBy: string;
        requestedSessionId: string;
        categories: readonly AdminPruneExpiredCategory[];
        expiredRows: Readonly<Partial<Record<AdminPruneExpiredCategory, number>>>;
    }>
): AdminPruneAggregate {
    return {
        version: 1,
        revision: 0,
        jobId: input.jobId,
        generatedAtEpochMs: input.generatedAtEpochMs,
        expireAtEpochMs: input.expireAtEpochMs,
        serverId: input.serverId,
        requestedBy: input.requestedBy,
        requestedSessionId: input.requestedSessionId,
        operation: 'maintenance.prune-expired',
        status: 'pending',
        changed: false,
        warnings: [],
        completedCategories: [],
        results: input.categories.map((category) => ({
            category,
            expiredRows: input.expiredRows[category] ?? 0,
            deletedRows: 0,
            dryRun: false
        }))
    };
}

export function advanceAdminPruneAggregate(
    aggregate: AdminPruneAggregate,
    page: AdminPrunePageProgress
): AdminPruneAggregate {
    if (aggregate.status !== 'pending' || aggregate.jobId !== page.jobId) {
        throw new TypeError('Admin prune aggregate identity is invalid');
    }
    const categories = aggregate.results.map((result) => result.category);
    if (!categories.includes(page.category)) {
        throw new TypeError('Admin prune aggregate category is invalid');
    }
    const completedCategories = page.next === null
        ? [...new Set([...aggregate.completedCategories, page.category])]
        : aggregate.completedCategories;
    const results = aggregate.results.map((result) =>
        result.category === page.category
            ? { ...result, deletedRows: result.deletedRows + page.deletedRows }
            : result
    );
    if (results.some((result) => result.deletedRows > result.expiredRows)) {
        throw new TypeError('Admin prune deleted rows exceed captured expired rows');
    }
    return {
        ...aggregate,
        revision: aggregate.revision + 1,
        status: completedCategories.length === results.length ? 'completed' : 'pending',
        changed: results.some((result) => result.deletedRows > 0),
        completedCategories,
        results
    };
}

export function decodeAdminPruneAggregate(value: unknown): AdminPruneAggregate {
    if (!isRecord(value)) {
        throw new TypeError('Admin prune aggregate is invalid');
    }
    requireExactKeys(value, [
        'version',
        'revision',
        'jobId',
        'generatedAtEpochMs',
        'expireAtEpochMs',
        'serverId',
        'requestedBy',
        'requestedSessionId',
        'operation',
        'status',
        'changed',
        'warnings',
        'completedCategories',
        'results'
    ]);
    if (value.version !== 1 || !isNonNegativeSafeInteger(value.revision)) {
        throw new TypeError('Admin prune aggregate is invalid');
    }
    if (
        isNonNegativeSafeInteger(value.generatedAtEpochMs) &&
        isNonNegativeSafeInteger(value.expireAtEpochMs) &&
        value.expireAtEpochMs <= value.generatedAtEpochMs
    ) {
        throw new TypeError('Admin prune aggregate expiry must follow generation');
    }
    if (Array.isArray(value.results) && value.results.length === 0) {
        throw new TypeError('Admin prune aggregate results must not be empty');
    }
    if (
        !isNonEmptyString(value.jobId) || !isNonNegativeSafeInteger(value.generatedAtEpochMs) ||
        !isNonNegativeSafeInteger(value.expireAtEpochMs) ||
        value.expireAtEpochMs <= value.generatedAtEpochMs || !isNonEmptyString(value.serverId) ||
        !isNonEmptyString(value.requestedBy) || !isNonEmptyString(value.requestedSessionId) ||
        value.operation !== 'maintenance.prune-expired' ||
        (value.status !== 'pending' && value.status !== 'completed') ||
        typeof value.changed !== 'boolean' || !Array.isArray(value.warnings) || value.warnings.length !== 0 ||
        !Array.isArray(value.completedCategories) || !Array.isArray(value.results) ||
        value.results.length === 0
    ) {
        throw new TypeError('Admin prune aggregate fields are invalid');
    }
    const completed = value.completedCategories.map(readCategory);
    if (new Set(completed).size !== completed.length) {
        throw new TypeError('Admin prune aggregate has duplicate completed category');
    }
    const results: readonly AdminPruneCategoryResult[] = value.results.map((entry) => {
        if (!isRecord(entry)) {
            throw new TypeError('Admin prune aggregate result is invalid');
        }
        requireExactKeys(entry, ['category', 'expiredRows', 'deletedRows', 'dryRun']);
        const category = readCategory(entry.category);
        if (
            !isNonNegativeSafeInteger(entry.expiredRows) ||
            !isNonNegativeSafeInteger(entry.deletedRows) ||
            entry.dryRun !== false
        ) {
            throw new TypeError('Admin prune aggregate result fields are invalid');
        }
        if (entry.deletedRows > entry.expiredRows) {
            throw new TypeError('Admin prune aggregate deleted rows exceed expired rows');
        }
        return {
            category,
            expiredRows: entry.expiredRows,
            deletedRows: entry.deletedRows,
            dryRun: false
        };
    });
    const categories = results.map((entry) => entry.category);
    if (new Set(categories).size !== categories.length) {
        throw new TypeError('Admin prune aggregate has duplicate result category');
    }
    if (completed.some((category) => !categories.includes(category))) {
        throw new TypeError('Admin prune aggregate completion category is invalid');
    }
    if (value.revision < completed.length) {
        throw new TypeError('Admin prune aggregate revision precedes completion progress');
    }
    const isComplete = completed.length === categories.length;
    if ((value.status === 'completed') !== isComplete) {
        throw new TypeError('Admin prune aggregate completion status is invalid');
    }
    const changed = results.some((entry) => entry.deletedRows > 0);
    if (value.changed !== changed) {
        throw new TypeError('Admin prune aggregate changed status is invalid');
    }
    return {
        version: 1,
        revision: value.revision,
        jobId: value.jobId,
        generatedAtEpochMs: value.generatedAtEpochMs,
        expireAtEpochMs: value.expireAtEpochMs,
        serverId: value.serverId,
        requestedBy: value.requestedBy,
        requestedSessionId: value.requestedSessionId,
        operation: 'maintenance.prune-expired',
        status: value.status,
        changed: value.changed,
        warnings: [],
        completedCategories: completed,
        results
    };
}

export function toAdminPruneCompletedResult(
    aggregate: AdminPruneAggregate
): AdminPruneCompletedResult {
    if (aggregate.status !== 'completed') {
        throw new TypeError('Admin prune aggregate is incomplete');
    }
    return {
        generatedAtEpochMs: aggregate.generatedAtEpochMs,
        serverId: aggregate.serverId,
        warnings: [],
        operation: aggregate.operation,
        status: 'completed',
        changed: aggregate.changed,
        jobId: aggregate.jobId,
        results: aggregate.results
    };
}

export function toAdminPruneCompletedResultForCommand(
    aggregate: AdminPruneAggregate,
    command: AdminPruneCommand
): AdminPruneCompletedResult {
    const matches = !command.dryRun &&
        aggregate.jobId === command.jobId &&
        aggregate.generatedAtEpochMs === command.capturedAtEpochMs &&
        aggregate.expireAtEpochMs >= command.expireAtEpochMs &&
        aggregate.requestedBy === command.requestedBy &&
        aggregate.requestedSessionId === command.requestedSessionId &&
        aggregate.results.length === command.categories.length &&
        aggregate.results.every((result, index) => result.category === command.categories[index]);
    if (!matches) {
        throw new TypeError('Admin prune aggregate differs from command');
    }
    return toAdminPruneCompletedResult(aggregate);
}

export function toAdminPruneAggregateKey(jobId: string): Key {
    return toAppQueueKey({
        topicId: ADMIN_PRUNE_AGGREGATE_TOPIC,
        resourceId: jobId,
        contextId: jobId
    });
}

export function toAdminPruneAggregateEntry(aggregate: AdminPruneAggregate): ResourceEntry {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(aggregate.generatedAtEpochMs)
        .toZonedDateTimeISO('UTC').toPlainDateTime();
    return {
        key: toAdminPruneAggregateKey(aggregate.jobId),
        resource: JSON.stringify(aggregate),
        typeId: EnqueuedType.APP_OUTBOX,
        status: aggregate.status === 'completed' ? EntityStatus.COMPLETED : EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(aggregate.serverId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(aggregate.expireAtEpochMs)
        },
        dequeueAudit: { attempts: 0 }
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
        throw new TypeError('Admin prune aggregate fields are invalid');
    }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function readCategory(value: unknown): AdminPruneExpiredCategory {
    for (const category of ADMIN_PRUNE_EXPIRED_CATEGORIES) {
        if (value === category) {
            return category;
        }
    }
    throw new TypeError('Admin prune aggregate category is invalid');
}
