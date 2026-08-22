import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategory,
    type AdminPruneExpiredRequest
} from '@shared/api/admin-operations-types.ts';
import type { RallarCrdtJsonValue } from '@shared/crdt/mod.ts';

import type { AdminPruneAppData } from './admin-prune-command-codec.ts';

export interface AdminPruneEnqueueResult {
    readonly generatedAtEpochMs: number;
    readonly serverId: string;
    readonly warnings: readonly [];
    readonly operation: 'maintenance.prune-expired';
    readonly status: 'dry-run' | 'queued' | 'completed';
    readonly changed: boolean;
    readonly jobId: string;
    readonly results: readonly Readonly<{
        category: AdminPruneExpiredCategory;
        expiredRows: number;
        deletedRows: number;
        dryRun: boolean;
    }>[];
}

export interface AdminPruneNormalizedRequest {
    readonly categories: readonly AdminPruneExpiredCategory[];
    readonly appData: AdminPruneAppData | null;
    readonly dryRun: boolean;
}

export function decodeAdminPruneRequest(
    request: AdminPruneExpiredRequest
): AdminPruneNormalizedRequest {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new TypeError('Admin prune request must be an object');
    }
    const categories = readCategories(request.categories);
    const appData = readAppData(request.appData);
    if (categories.includes('app-data') && appData === null) {
        throw new TypeError('appData.namespace is required for app-data pruning');
    }
    return {
        categories,
        appData,
        dryRun: request.dryRun === undefined ? true : requireBoolean(request.dryRun)
    };
}

export function decodeAdminPruneEnqueueResult(value: RallarCrdtJsonValue): AdminPruneEnqueueResult {
    const result = requireExactRecord(value, [
        'generatedAtEpochMs',
        'serverId',
        'warnings',
        'operation',
        'status',
        'changed',
        'jobId',
        'results'
    ], 'Admin prune result');
    const serverId = readNonEmptyString(result.serverId);
    const jobId = readNonEmptyString(result.jobId);
    if (
        serverId === null ||
        !Array.isArray(result.warnings) ||
        result.warnings.length !== 0 ||
        result.operation !== 'maintenance.prune-expired' ||
        !['dry-run', 'queued', 'completed'].includes(String(result.status)) ||
        typeof result.changed !== 'boolean' ||
        jobId === null ||
        !Array.isArray(result.results) ||
        result.results.length === 0
    ) {
        throw new TypeError('Admin prune result fields are invalid');
    }
    const status = readAdminPruneStatus(result.status);
    const categoryResults = result.results.map(decodeAdminPruneCategoryResult);
    const categories = categoryResults.map((categoryResult) => categoryResult.category);
    if (new Set(categories).size !== categories.length) {
        throw new TypeError('Admin prune result has duplicate categories');
    }
    const expectedDryRun = status === 'dry-run';
    if (categoryResults.some((categoryResult) => categoryResult.dryRun !== expectedDryRun)) {
        throw new TypeError('Admin prune result dry-run status is invalid');
    }
    if (status === 'queued' && categoryResults.some((categoryResult) => categoryResult.deletedRows !== 0)) {
        throw new TypeError('Admin prune queued result has deleted rows');
    }
    const changed = categoryResults.some((categoryResult) => categoryResult.deletedRows > 0);
    if (result.changed !== changed) {
        throw new TypeError('Admin prune result changed status is invalid');
    }
    return {
        generatedAtEpochMs: readNonNegativeSafeInteger(
            result.generatedAtEpochMs,
            'Admin prune result generation time is invalid'
        ),
        serverId,
        warnings: [],
        operation: 'maintenance.prune-expired',
        status,
        changed: result.changed,
        jobId,
        results: categoryResults
    };
}

function readCategories(
    value: AdminPruneExpiredRequest['categories']
): readonly AdminPruneExpiredCategory[] {
    if (value === undefined) {
        return ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) => category !== 'app-data');
    }
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError('categories are invalid');
    }
    return [...new Set(value.map(readCategory))];
}

function readAppData(value: AdminPruneExpiredRequest['appData']): AdminPruneAppData | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('appData must be an object');
    }
    const namespace = readNonEmptyString(value.namespace);
    if (namespace === null) {
        throw new TypeError('appData.namespace is required');
    }
    return {
        namespace,
        storeName: readNonEmptyString(value.storeName)
    };
}

function decodeAdminPruneCategoryResult(
    value: RallarCrdtJsonValue
): AdminPruneEnqueueResult['results'][number] {
    const result = requireExactRecord(
        value,
        ['category', 'expiredRows', 'deletedRows', 'dryRun'],
        'Admin prune category result'
    );
    if (typeof result.dryRun !== 'boolean') {
        throw new TypeError('Admin prune category result fields are invalid');
    }
    const decoded = {
        category: readCategory(result.category),
        expiredRows: readNonNegativeSafeInteger(
            result.expiredRows,
            'Admin prune expired row count is invalid'
        ),
        deletedRows: readNonNegativeSafeInteger(
            result.deletedRows,
            'Admin prune deleted row count is invalid'
        ),
        dryRun: result.dryRun
    };
    if (decoded.deletedRows > decoded.expiredRows) {
        throw new TypeError('Admin prune deleted rows exceed expired rows');
    }
    return decoded;
}

function requireExactRecord(
    value: RallarCrdtJsonValue,
    keys: readonly string[],
    label: string
): Readonly<Record<string, RallarCrdtJsonValue>> {
    if (!isJsonRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
        throw new TypeError(`${label} fields are invalid`);
    }
    return value;
}

function isJsonRecord(
    value: RallarCrdtJsonValue
): value is Readonly<Record<string, RallarCrdtJsonValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCategory(value: RallarCrdtJsonValue | undefined): AdminPruneExpiredCategory {
    switch (value) {
        case 'runtime-state':
        case 'resource-inbox':
        case 'resource-inbox-results':
        case 'app-data':
            return value;
        default:
            throw new TypeError('Admin prune category is invalid');
    }
}

function readNonEmptyString(value: RallarCrdtJsonValue | undefined): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireBoolean(value: boolean): boolean {
    if (typeof value !== 'boolean') {
        throw new TypeError('dryRun must be boolean');
    }
    return value;
}

function readNonNegativeSafeInteger(
    value: RallarCrdtJsonValue | undefined,
    message: string
): number {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
        throw new TypeError(message);
    }
    return value;
}

function readAdminPruneStatus(
    value: RallarCrdtJsonValue | undefined
): AdminPruneEnqueueResult['status'] {
    switch (value) {
        case 'dry-run':
        case 'queued':
        case 'completed':
            return value;
        default:
            throw new TypeError('Admin prune result status is invalid');
    }
}
