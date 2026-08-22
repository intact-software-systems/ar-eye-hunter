import { ADMIN_PRUNE_EXPIRED_CATEGORIES, type AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { hashRallarCrdtJson } from '@shared/crdt/crdt-hash.ts';
import type { JsonWireObject, JsonWireValue } from '../../services/mutation-command-identity.ts';

const ADMIN_PRUNE_PAGE_SIZE_LIMIT = 500;

export interface AdminPruneAppData extends JsonWireObject {
    readonly namespace: string;
    readonly storeName: string | null;
}

export interface AdminPruneCommand extends JsonWireObject {
    readonly version: 1;
    readonly jobId: string;
    readonly commandHash: string;
    readonly requestedBy: string;
    readonly requestedSessionId: string;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly dryRun: boolean;
    readonly categories: readonly AdminPruneExpiredCategory[];
    readonly appData: AdminPruneAppData | null;
    readonly pageSize: number;
}

export async function createAdminPruneCommand(
    input: Omit<AdminPruneCommand, 'version' | 'commandHash'>
): Promise<AdminPruneCommand> {
    const stable = { ...input, version: 1 as const };
    return decodeAdminPruneCommand({
        ...stable,
        commandHash: hashRallarCrdtJson(stable)
    });
}

export function decodeAdminPruneCommand(value: JsonWireValue): AdminPruneCommand {
    const command = readExactRecord(value, [
        'version',
        'jobId',
        'commandHash',
        'requestedBy',
        'requestedSessionId',
        'capturedAtEpochMs',
        'expireAtEpochMs',
        'dryRun',
        'categories',
        'appData',
        'pageSize'
    ], 'admin prune command');
    if (command.version !== 1) {
        throw new TypeError('Admin prune command version is invalid');
    }
    requireAdminPruneString(command.jobId, 'jobId');
    requireAdminPruneString(command.commandHash, 'commandHash');
    requireAdminPruneString(command.requestedBy, 'requestedBy');
    requireAdminPruneString(command.requestedSessionId, 'requestedSessionId');
    requireAdminPruneEpoch(command.capturedAtEpochMs, 'capturedAtEpochMs');
    requireAdminPruneEpoch(command.expireAtEpochMs, 'expireAtEpochMs');
    if (command.expireAtEpochMs <= command.capturedAtEpochMs) {
        throw new TypeError('Admin prune expiry must follow capture time');
    }
    if (typeof command.dryRun !== 'boolean') {
        throw new TypeError('dryRun must be boolean');
    }
    requireAdminPruneCategories(command.categories);
    const appData = decodeAdminPruneAppData(command.appData);
    if (command.categories.includes('app-data') !== (appData !== null)) {
        throw new TypeError('Admin prune app-data category and details differ');
    }
    const pageSize = requireAdminPrunePageSize(command.pageSize);
    const { commandHash: _commandHash, ...stable } = command;
    if (hashRallarCrdtJson(stable) !== command.commandHash) {
        throw new TypeError('Admin prune command hash differs from canonical command');
    }
    return {
        version: 1,
        jobId: command.jobId,
        commandHash: command.commandHash,
        requestedBy: command.requestedBy,
        requestedSessionId: command.requestedSessionId,
        capturedAtEpochMs: command.capturedAtEpochMs,
        expireAtEpochMs: command.expireAtEpochMs,
        dryRun: command.dryRun,
        categories: command.categories,
        appData,
        pageSize
    };
}

export function decodeAdminPruneAppData(value: JsonWireValue): AdminPruneAppData | null {
    if (value === null) {
        return null;
    }
    const data = readExactRecord(value, ['namespace', 'storeName'], 'appData');
    requireAdminPruneString(data.namespace, 'appData.namespace');
    if (data.storeName !== null) {
        requireAdminPruneString(data.storeName, 'appData.storeName');
    }
    return {
        namespace: data.namespace,
        storeName: data.storeName
    };
}

export function requireAdminPruneCategory(value: JsonWireValue): asserts value is AdminPruneExpiredCategory {
    if (!isAdminPruneExpiredCategory(value)) {
        throw new TypeError('Admin prune category is invalid');
    }
}

export function requireAdminPrunePageSize(value: JsonWireValue): number {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1 || value > ADMIN_PRUNE_PAGE_SIZE_LIMIT) {
        throw new TypeError('Admin prune pageSize is invalid');
    }
    return value;
}

export function readExactRecord(
    value: JsonWireValue,
    keys: readonly string[],
    label: string
): JsonWireObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const record = value as JsonWireObject;
    if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
        throw new TypeError(`${label} fields are invalid`);
    }
    return record;
}

export function requireAdminPruneString(value: JsonWireValue, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function requireAdminPruneEpoch(value: JsonWireValue, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function requireAdminPruneCategories(
    value: JsonWireValue
): asserts value is readonly AdminPruneExpiredCategory[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError('categories are invalid');
    }
    value.forEach(requireAdminPruneCategory);
    if (new Set(value).size !== value.length) {
        throw new TypeError('categories contain duplicates');
    }
}

function isAdminPruneExpiredCategory(value: JsonWireValue): value is AdminPruneExpiredCategory {
    return ADMIN_PRUNE_EXPIRED_CATEGORIES.some((category) => category === value);
}
