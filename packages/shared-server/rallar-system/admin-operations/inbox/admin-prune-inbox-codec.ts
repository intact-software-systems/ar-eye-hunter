import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategory,
    type AdminPruneExpiredRequest
} from '@shared/api/admin-operations-types.ts';
import {
    decodeAdminPruneEnqueueResult,
    type AdminPruneEnqueueResult
} from '@shared/api/admin-rooms/decode-admin-prune-result.ts';
import type { RallarCrdtJsonValue } from '@shared/crdt/mod.ts';

import type { AdminPruneAppData, AdminPruneCommand } from './admin-prune-command-codec.ts';

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

export function decodeAdminPruneEnqueueResultForCommand(
    value: RallarCrdtJsonValue,
    command: AdminPruneCommand
): AdminPruneEnqueueResult {
    const result = decodeAdminPruneEnqueueResult(value);
    const expectedStatus = command.dryRun ? 'dry-run' : 'queued';
    const matches = result.jobId === command.jobId &&
        result.generatedAtEpochMs === command.capturedAtEpochMs &&
        result.status === expectedStatus &&
        result.results.length === command.categories.length &&
        result.results.every((categoryResult, index) =>
            categoryResult.category === command.categories[index] &&
            categoryResult.dryRun === command.dryRun
        );
    if (!matches) {
        throw new TypeError('Admin prune durable result differs from command');
    }
    return result;
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
