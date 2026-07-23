import { Temporal } from '@js-temporal/polyfill';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    ADMIN_PRUNE_EXPIRED_CATEGORIES,
    type AdminPruneExpiredCategory,
} from '@shared/api/admin-operations-types.ts';
import { hashRallarCrdtJson } from '@shared/crdt/crdt-hash.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql, PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { runInTransaction } from '../../postgres/run-in-transaction.ts';
import { toAppQueueCreatedBy } from '../services/app-inbox-queue-key.ts';

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
    capturedAtEpochMs: number;
    expireAtEpochMs: number;
    pageSize: number;
    afterCursor: string | null;
    pageIndex: number;
    appData: AdminPruneAppData | null;
}>;

type ReservedAdminPrunePageWork = AdminPrunePageWork & Readonly<{
    reservation: ResourceEntry;
}>;

export type AdminPrunePageRead = Readonly<{
    rowIds: readonly string[];
    hasMore: boolean;
}>;

export type AdminPrunePageComputed = Readonly<{
    kind: 'page';
    jobId: string;
    category: AdminPruneExpiredCategory;
    rowIds: readonly string[];
    deletedRows: number;
    next: AdminPrunePageWork | null;
}>;

export type AdminPruneExpiredRepository = Readonly<{
    readPage(input: Readonly<{
        category: AdminPruneExpiredCategory;
        pageSize: number;
        afterCursor: string | null;
        expireAtEpochMs: number;
        appData: AdminPruneAppData | null;
        excludedResourceId: string | null;
    }>): Promise<AdminPrunePageRead>;
    deletePage(
        transaction: PSqlTransactionSql,
        command: AdminPrunePageWork,
        rowIds: readonly string[],
    ): Promise<number>;
    writeOutbox(transaction: PSqlTransactionSql, entry: ResourceEntry): Promise<void>;
    writeProgress(
        transaction: PSqlTransactionSql,
        computed: AdminPrunePageComputed,
    ): Promise<void>;
    finishReserved(
        transaction: PSqlTransactionSql,
        entry: ResourceEntry,
    ): Promise<boolean>;
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
    if (typeof command.dryRun !== 'boolean') throw new TypeError('dryRun must be boolean');
    requireCategories(command.categories);
    decodeAppData(command.appData);
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
    const payload = exactRecord(outer.payload, ['typeId', 'contentType', 'resource'], 'admin prune payload');
    if (payload.typeId !== 'ADMIN_PRUNE_EXPIRED' || payload.contentType !== 'application/json') {
        throw new TypeError('Admin prune payload identity is invalid');
    }
    if (typeof payload.resource !== 'string') throw new TypeError('Admin prune resource is invalid');
    const work = decodePageWork(JSON.parse(payload.resource));
    return { ...work, reservation: entry };
}

export class AdminPruneExpiredWork {
    private readonly pageSize: number;
    private readonly now: () => number;

    constructor(private readonly options: Readonly<{
        database: PSqlSql;
        repository: AdminPruneExpiredRepository;
        serviceId: string;
        pageSize: number;
        now?: () => number;
        wakeQueue?: () => void;
    }>) {
        this.pageSize = requirePageSize(options.pageSize);
        this.now = options.now ?? (() => Date.now());
    }

    async read(command: ReservedAdminPrunePageWork): Promise<AdminPrunePageRead> {
        if (command.pageSize > this.pageSize) throw new TypeError('Admin prune page exceeds configured size');
        return await this.options.repository.readPage({
            category: command.category,
            pageSize: command.pageSize,
            afterCursor: command.afterCursor,
            expireAtEpochMs: command.capturedAtEpochMs,
            appData: command.appData,
            excludedResourceId: command.category === 'resource-inbox'
                ? command.reservation.key.resourceId
                : null,
        });
    }

    compute(
        command: ReservedAdminPrunePageWork,
        read: AdminPrunePageRead,
    ): AdminPrunePageComputed {
        const cursor = read.rowIds.at(-1) ?? command.afterCursor;
        return {
            kind: 'page',
            jobId: command.jobId,
            category: command.category,
            rowIds: read.rowIds,
            deletedRows: read.rowIds.length,
            next: read.hasMore && cursor !== null
                ? {
                    kind: 'page',
                    jobId: command.jobId,
                    category: command.category,
                    capturedAtEpochMs: command.capturedAtEpochMs,
                    expireAtEpochMs: command.expireAtEpochMs,
                    pageSize: command.pageSize,
                    afterCursor: cursor,
                    pageIndex: command.pageIndex + 1,
                    appData: command.appData,
                }
                : null,
        };
    }

    validate(
        command: ReservedAdminPrunePageWork,
        read: AdminPrunePageRead,
        computed: AdminPrunePageComputed,
    ): void {
        if (computed.jobId !== command.jobId || computed.category !== command.category) {
            throw new TypeError('Admin prune computed identity differs from command');
        }
        if (read.rowIds.length > command.pageSize || computed.deletedRows !== read.rowIds.length) {
            throw new TypeError('Admin prune computed page exceeds its command');
        }
    }

    async write(
        transaction: PSqlTransactionSql,
        computed: AdminPrunePageComputed,
        entry: ResourceEntry,
    ): Promise<void> {
        const command = decodeAdminPruneWork(entry);
        const deleted = await this.options.repository.deletePage(transaction, command, computed.rowIds);
        if (deleted !== computed.deletedRows) throw new Error('Admin prune page changed before delete');
        await this.options.repository.writeProgress(transaction, computed);
        if (computed.next) {
            await this.options.repository.writeOutbox(
                transaction,
                toAdminPruneOutbox(computed.next, this.options.serviceId),
            );
        }
        if (!await this.options.repository.finishReserved(transaction, entry)) {
            throw new Error('Admin prune reservation changed before commit');
        }
    }

    async processReservedEntry(entry: ResourceEntry): Promise<void> {
        const command = decodeAdminPruneWork(entry);
        const read = await this.read(command);
        const computed = this.compute(command, read);
        this.validate(command, read, computed);
        await runInTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed, entry);
        });
        this.options.wakeQueue?.();
    }
}

export function toAdminPruneOutbox(work: AdminPrunePageWork, serviceId: string): ResourceEntry {
    const resourceId = `${work.jobId}:${work.category}:${work.pageIndex}`;
    const route = {
        topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
        resourceId,
        contextId: work.jobId,
    };
    const message = {
        id: { v: 2, msgId: resourceId, ts: work.capturedAtEpochMs, senderId: serviceId },
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
        'kind', 'jobId', 'category', 'capturedAtEpochMs', 'expireAtEpochMs',
        'pageSize', 'afterCursor', 'pageIndex', 'appData',
    ], 'admin prune page work');
    if (work.kind !== 'page') throw new TypeError('Admin prune work kind is invalid');
    requireString(work.jobId, 'jobId');
    requireCategory(work.category);
    requireEpoch(work.capturedAtEpochMs, 'capturedAtEpochMs');
    requireEpoch(work.expireAtEpochMs, 'expireAtEpochMs');
    requirePageSize(work.pageSize);
    if (work.afterCursor !== null) requireString(work.afterCursor, 'afterCursor');
    requireEpoch(work.pageIndex, 'pageIndex');
    decodeAppData(work.appData);
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

function requirePageSize(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > ADMIN_PRUNE_PAGE_SIZE_LIMIT) {
        throw new TypeError('Admin prune pageSize is invalid');
    }
    return value as number;
}

function toPlainDateTime(epochMs: number): Temporal.PlainDateTime {
    return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO('UTC').toPlainDateTime();
}
