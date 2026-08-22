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
    const result = requireRecord(value, 'Admin prune result must be an object');
    if (
        typeof result.serverId !== 'string' ||
        !Array.isArray(result.warnings) ||
        result.warnings.length !== 0 ||
        result.operation !== 'maintenance.prune-expired' ||
        !['dry-run', 'queued', 'completed'].includes(String(result.status)) ||
        typeof result.changed !== 'boolean' ||
        typeof result.jobId !== 'string' ||
        !Array.isArray(result.results)
    ) {
        throw new TypeError('Admin prune result fields are invalid');
    }
    return {
        generatedAtEpochMs: readNonNegativeSafeInteger(
            result.generatedAtEpochMs,
            'Admin prune result generation time is invalid'
        ),
        serverId: result.serverId,
        warnings: [],
        operation: 'maintenance.prune-expired',
        status: readAdminPruneStatus(result.status),
        changed: result.changed,
        jobId: result.jobId,
        results: result.results.map(decodeAdminPruneCategoryResult)
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
    const result = requireRecord(value, 'Admin prune category result must be an object');
    if (typeof result.dryRun !== 'boolean') {
        throw new TypeError('Admin prune category result fields are invalid');
    }
    return {
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
}

function requireRecord(
    value: RallarCrdtJsonValue,
    message: string
): Readonly<Record<string, RallarCrdtJsonValue>> {
    if (!isJsonRecord(value)) {
        throw new TypeError(message);
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
