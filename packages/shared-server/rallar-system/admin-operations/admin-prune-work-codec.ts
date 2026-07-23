import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategory,
} from '@shared/api/admin-operations-types.ts';
import { hashRallarCrdtJson } from '@shared/crdt/crdt-hash.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from '../services/app-inbox-queue-key.ts';

export const ADMIN_PRUNE_APP_OUTBOX_TOPIC = 'rallar.admin.prune-expired';
const ADMIN_PRUNE_PAGE_SIZE_LIMIT = 500;

export type AdminPruneAppData = Readonly<{
    namespace: string;
    storeName: string | null;
}>;

export type AdminPruneCommand = Readonly<{
    version: 1;
    jobId: string;
    commandHash: string;
    requestedBy: string;
    requestedSessionId: string;
    capturedAtEpochMs: number;
    expireAtEpochMs: number;
    dryRun: boolean;
    categories: readonly AdminPruneExpiredCategory[];
    appData: AdminPruneAppData | null;
    pageSize: number;
}>;

export type AdminPrunePageWork = Readonly<{
    kind: 'page';
    jobId: string;
    category: AdminPruneExpiredCategory;
    requestedBy: string;
    requestedSessionId: string;
    capturedAtEpochMs: number;
    expireAtEpochMs: number;
    pageSize: number;
    afterCursor: string | null;
    pageIndex: number;
    appData: AdminPruneAppData | null;
}>;

export type ReservedAdminPrunePageWork = AdminPrunePageWork & Readonly<{
    reservation: ResourceEntry;
}>;

export async function createAdminPruneCommand(
    input: Omit<AdminPruneCommand, 'version' | 'commandHash'>,
): Promise<AdminPruneCommand> {
    const stable = { ...input, version: 1 as const };
    return decodeAdminPruneCommand({
        ...stable,
        commandHash: hashRallarCrdtJson(stable),
    });
}

export function decodeAdminPruneCommand(value: unknown): AdminPruneCommand {
    const command = exactRecord(value, [
        'version', 'jobId', 'commandHash', 'requestedBy', 'requestedSessionId',
        'capturedAtEpochMs', 'expireAtEpochMs', 'dryRun', 'categories', 'appData',
        'pageSize',
    ], 'admin prune command');
    if (command.version !== 1) throw new TypeError('Admin prune command version is invalid');
    requireString(command.jobId, 'jobId');
    requireString(command.commandHash, 'commandHash');
    requireString(command.requestedBy, 'requestedBy');
    requireString(command.requestedSessionId, 'requestedSessionId');
    requireEpoch(command.capturedAtEpochMs, 'capturedAtEpochMs');
    requireEpoch(command.expireAtEpochMs, 'expireAtEpochMs');
    if ((command.expireAtEpochMs as number) <= (command.capturedAtEpochMs as number)) {
        throw new TypeError('Admin prune expiry must follow capture time');
    }
    if (typeof command.dryRun !== 'boolean') throw new TypeError('dryRun must be boolean');
    requireCategories(command.categories);
    decodeAppData(command.appData);
    const includesAppData = (command.categories as readonly unknown[]).includes('app-data');
    if (includesAppData !== (command.appData !== null)) {
        throw new TypeError('Admin prune app-data category and details differ');
    }
    requirePageSize(command.pageSize);
    const { commandHash: _hash, ...stable } = command;
    if (hashRallarCrdtJson(stable) !== command.commandHash) {
        throw new TypeError('Admin prune command hash differs from canonical command');
    }
    return command as unknown as AdminPruneCommand;
}

export function decodeAdminPruneWork(entry: ResourceEntry): ReservedAdminPrunePageWork {
    if (entry.typeId !== EnqueuedType.APP_OUTBOX || entry.status !== EntityStatus.RESERVED) {
        throw new TypeError('Admin prune work must be a reserved APP_OUTBOX entry');
    }
    const outer = exactRecord(JSON.parse(entry.resource), [
        'id', 'route', 'targets', 'constraints', 'payload', 'audit',
    ], 'admin prune message');
    const id = exactRecord(outer.id, ['v', 'msgId', 'ts', 'senderId'], 'admin prune id');
    const route = exactRecord(outer.route, ['topicId', 'resourceId', 'contextId'], 'admin prune route');
    const targets = exactRecord(outer.targets, ['mode', 'scope'], 'admin prune targets');
    const constraints = exactRecord(outer.constraints, ['expiresAtMs'], 'admin prune constraints');
    const audit = exactRecord(outer.audit, ['createdBy', 'createdTs'], 'admin prune audit');
    const payload = exactRecord(outer.payload, ['typeId', 'contentType', 'resource'], 'admin prune payload');
    if (payload.typeId !== 'ADMIN_PRUNE_EXPIRED' || payload.contentType !== 'application/json') {
        throw new TypeError('Admin prune payload identity is invalid');
    }
    if (typeof payload.resource !== 'string') throw new TypeError('Admin prune resource is invalid');
    const work = decodePageWork(JSON.parse(payload.resource));
    const expectedRoute = toAppQueueKey({
        topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
        resourceId: `${work.jobId}:${work.category}:${work.pageIndex}`,
        contextId: work.jobId,
    });
    if (
        id.v !== 2 || id.msgId !== expectedRoute.resourceId || id.ts !== work.capturedAtEpochMs ||
        typeof id.senderId !== 'string' || id.senderId.length === 0 ||
        route.topicId !== expectedRoute.topicId || route.resourceId !== expectedRoute.resourceId ||
        route.contextId !== expectedRoute.contextId || entry.key.topicId !== route.topicId ||
        entry.key.resourceId !== route.resourceId || entry.key.contextId !== route.contextId ||
        targets.mode !== 'all' || targets.scope !== 'global' ||
        constraints.expiresAtMs !== work.expireAtEpochMs ||
        audit.createdBy !== id.senderId || audit.createdTs !== work.capturedAtEpochMs ||
        entry.audit.createdBy !== toAppQueueCreatedBy(id.senderId) ||
        entry.audit.createdTs.toString() !== toPlainDateTime(work.capturedAtEpochMs).toString() ||
        Number(entry.audit.expiryTs.epochMilliseconds) !== work.expireAtEpochMs
    ) throw new TypeError('Admin prune work route, sender, expiry, or audit identity is invalid');
    return { ...work, reservation: entry };
}

export function toAdminPruneOutbox(work: AdminPrunePageWork, serviceId: string): ResourceEntry {
    const route = toAppQueueKey({
        topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
        resourceId: `${work.jobId}:${work.category}:${work.pageIndex}`,
        contextId: work.jobId,
    });
    const message = {
        id: { v: 2, msgId: route.resourceId, ts: work.capturedAtEpochMs, senderId: serviceId },
        route,
        targets: { mode: 'all', scope: 'global' },
        constraints: { expiresAtMs: work.expireAtEpochMs },
        payload: {
            typeId: 'ADMIN_PRUNE_EXPIRED',
            contentType: 'application/json',
            resource: JSON.stringify(work),
        },
        audit: { createdBy: serviceId, createdTs: work.capturedAtEpochMs },
    };
    const createdTs = toPlainDateTime(work.capturedAtEpochMs);
    return {
        key: route,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: toAppQueueCreatedBy(serviceId),
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(work.expireAtEpochMs),
        },
        dequeueAudit: { attempts: 0 },
    };
}

function decodePageWork(value: unknown): AdminPrunePageWork {
    const work = exactRecord(value, [
        'kind', 'jobId', 'category', 'requestedBy', 'requestedSessionId',
        'capturedAtEpochMs', 'expireAtEpochMs',
        'pageSize', 'afterCursor', 'pageIndex', 'appData',
    ], 'admin prune page work');
    if (work.kind !== 'page') throw new TypeError('Admin prune work kind is invalid');
    requireString(work.jobId, 'jobId');
    requireCategory(work.category);
    requireString(work.requestedBy, 'requestedBy');
    requireString(work.requestedSessionId, 'requestedSessionId');
    requireEpoch(work.capturedAtEpochMs, 'capturedAtEpochMs');
    requireEpoch(work.expireAtEpochMs, 'expireAtEpochMs');
    if ((work.expireAtEpochMs as number) <= (work.capturedAtEpochMs as number)) {
        throw new TypeError('Admin prune page expiry must follow capture time');
    }
    requirePageSize(work.pageSize);
    if (work.afterCursor !== null) requireString(work.afterCursor, 'afterCursor');
    requireEpoch(work.pageIndex, 'pageIndex');
    decodeAppData(work.appData);
    if (((work.pageIndex as number) === 0) !== (work.afterCursor === null)) {
        throw new TypeError('Admin prune page cursor differs from page index');
    }
    if ((work.category === 'app-data') !== (work.appData !== null)) {
        throw new TypeError('Admin prune app-data category and details differ');
    }
    return work as unknown as AdminPrunePageWork;
}

function decodeAppData(value: unknown): AdminPruneAppData | null {
    if (value === null) return null;
    const data = exactRecord(value, ['namespace', 'storeName'], 'appData');
    requireString(data.namespace, 'appData.namespace');
    if (data.storeName !== null) requireString(data.storeName, 'appData.storeName');
    return data as unknown as AdminPruneAppData;
}

function requireCategories(value: unknown): asserts value is readonly AdminPruneExpiredCategory[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('categories are invalid');
    value.forEach(requireCategory);
    if (new Set(value).size !== value.length) throw new TypeError('categories contain duplicates');
}

function requireCategory(value: unknown): asserts value is AdminPruneExpiredCategory {
    if (!ADMIN_PRUNE_EXPIRED_CATEGORIES.includes(value as AdminPruneExpiredCategory)) {
        throw new TypeError('Admin prune category is invalid');
    }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
        throw new TypeError(`${label} fields are invalid`);
    }
    return record;
}

function requireString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
}

function requireEpoch(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} is invalid`);
}

export function requirePageSize(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > ADMIN_PRUNE_PAGE_SIZE_LIMIT) {
        throw new TypeError('Admin prune pageSize is invalid');
    }
    return value as number;
}

function toPlainDateTime(epochMs: number): Temporal.PlainDateTime {
    return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO('UTC').toPlainDateTime();
}
