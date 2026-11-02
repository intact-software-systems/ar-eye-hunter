import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategoryResult,
    type AdminPruneExpiredResultResponse
} from '../admin-operations-types.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';

export interface AdminPruneEnqueueResult extends AdminPruneExpiredResultResponse {
    readonly warnings: readonly [];
}

export function decodeAdminPruneEnqueueResult(value: unknown): AdminPruneEnqueueResult {
    const result = requireRecord(value, 'Admin prune result');
    requireExactKeys(result, [
        'generatedAtEpochMs',
        'serverId',
        'warnings',
        'operation',
        'status',
        'changed',
        'jobId',
        'results'
    ], 'Admin prune result');
    requireString(result.serverId, 'Admin prune serverId');
    requireString(result.jobId, 'Admin prune jobId');
    requireEpoch(result.generatedAtEpochMs, 'Admin prune result generation time');
    if (
        !Array.isArray(result.warnings) || result.warnings.length !== 0 ||
        result.operation !== 'maintenance.prune-expired' || typeof result.changed !== 'boolean' ||
        !Array.isArray(result.results) || result.results.length === 0
    ) {
        throw new TypeError('Admin prune result fields are invalid');
    }
    const decoded: AdminPruneEnqueueResult = {
        generatedAtEpochMs: result.generatedAtEpochMs,
        serverId: result.serverId,
        warnings: [],
        operation: 'maintenance.prune-expired',
        status: requireOneOf(result.status, ['dry-run', 'queued', 'completed'], 'Admin prune result status'),
        changed: result.changed,
        jobId: result.jobId,
        results: result.results.map(decodeAdminPruneCategoryResult)
    };
    validatePruneAggregate(decoded);
    return decoded;
}

function decodeAdminPruneCategoryResult(value: unknown): AdminPruneExpiredCategoryResult {
    const result = requireRecord(value, 'Admin prune category result');
    requireExactKeys(result, ['category', 'expiredRows', 'deletedRows', 'dryRun'], 'Admin prune category result');
    const category = requireOneOf(result.category, ADMIN_PRUNE_EXPIRED_CATEGORIES, 'Admin prune category');
    requireEpoch(result.expiredRows, 'Admin prune expired row count');
    requireEpoch(result.deletedRows, 'Admin prune deleted row count');
    if (typeof result.dryRun !== 'boolean') {
        throw new TypeError('Admin prune category result fields are invalid');
    }
    if (result.deletedRows > result.expiredRows) {
        throw new TypeError('Admin prune deleted rows exceed expired rows');
    }
    return { category, expiredRows: result.expiredRows, deletedRows: result.deletedRows, dryRun: result.dryRun };
}

function validatePruneAggregate(result: AdminPruneEnqueueResult): void {
    const categories = result.results.map((entry) => entry.category);
    if (new Set(categories).size !== categories.length) {
        throw new TypeError('Admin prune result has duplicate categories');
    }
    if (result.results.some((entry) => entry.dryRun !== (result.status === 'dry-run'))) {
        throw new TypeError('Admin prune result dry-run status is invalid');
    }
    if (result.status !== 'completed' && result.results.some((entry) => entry.deletedRows !== 0)) {
        throw new TypeError(`Admin prune ${result.status} result has deleted rows`);
    }
    if (result.changed !== result.results.some((entry) => entry.deletedRows > 0)) {
        throw new TypeError('Admin prune result changed status is invalid');
    }
}
