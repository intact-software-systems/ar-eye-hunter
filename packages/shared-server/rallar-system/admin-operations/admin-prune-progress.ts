import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toAppQueueCreatedBy } from '../services/app-inbox-queue-key.ts';
import type { AdminPrunePageComputed } from './AdminPruneExpiredWork.ts';

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

export function createAdminPruneAggregate(input: Readonly<{
    jobId: string;
    generatedAtEpochMs: number;
    expireAtEpochMs: number;
    serverId: string;
    categories: readonly AdminPruneExpiredCategory[];
    expiredRows: Readonly<Partial<Record<AdminPruneExpiredCategory, number>>>;
}>): AdminPruneAggregate {
    return {
        version: 1,
        revision: 0,
        jobId: input.jobId,
        generatedAtEpochMs: input.generatedAtEpochMs,
        expireAtEpochMs: input.expireAtEpochMs,
        serverId: input.serverId,
        operation: 'maintenance.prune-expired',
        status: 'pending',
        changed: false,
        warnings: [],
        completedCategories: [],
        results: input.categories.map((category) => ({
            category,
            expiredRows: input.expiredRows[category] ?? 0,
            deletedRows: 0,
            dryRun: false,
        })),
    };
}

export function advanceAdminPruneAggregate(
    aggregate: AdminPruneAggregate,
    page: AdminPrunePageComputed,
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
    const results = aggregate.results.map((result) => result.category === page.category
        ? { ...result, deletedRows: result.deletedRows + page.deletedRows }
        : result);
    return {
        ...aggregate,
        revision: aggregate.revision + 1,
        status: completedCategories.length === results.length ? 'completed' : 'pending',
        changed: results.some((result) => result.deletedRows > 0),
        completedCategories,
        results,
    };
}

export function decodeAdminPruneAggregate(value: unknown): AdminPruneAggregate {
    if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision)) {
        throw new TypeError('Admin prune aggregate is invalid');
    }
    if (
        typeof value.jobId !== 'string' || typeof value.generatedAtEpochMs !== 'number' ||
        typeof value.expireAtEpochMs !== 'number' || typeof value.serverId !== 'string' ||
        value.operation !== 'maintenance.prune-expired' ||
        (value.status !== 'pending' && value.status !== 'completed') ||
        typeof value.changed !== 'boolean' || !Array.isArray(value.warnings) ||
        !Array.isArray(value.completedCategories) || !Array.isArray(value.results)
    ) throw new TypeError('Admin prune aggregate fields are invalid');
    return value as unknown as AdminPruneAggregate;
}

export function toAdminPruneCompletedResult(
    aggregate: AdminPruneAggregate,
): AdminPruneCompletedResult {
    if (aggregate.status !== 'completed') throw new TypeError('Admin prune aggregate is incomplete');
    return {
        generatedAtEpochMs: aggregate.generatedAtEpochMs,
        serverId: aggregate.serverId,
        warnings: [],
        operation: aggregate.operation,
        status: 'completed',
        changed: aggregate.changed,
        jobId: aggregate.jobId,
        results: aggregate.results,
    };
}

export function toAdminPruneAggregateKey(jobId: string): Key {
    return { topicId: ADMIN_PRUNE_AGGREGATE_TOPIC, resourceId: jobId, contextId: jobId };
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
            expiryTs: Temporal.Instant.fromEpochMilliseconds(aggregate.expireAtEpochMs),
        },
        dequeueAudit: { attempts: 0 },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
