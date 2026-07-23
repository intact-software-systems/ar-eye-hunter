import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    ADMIN_PRUNE_APP_OUTBOX_TOPIC,
    AdminPruneExpiredWork,
    createAdminPruneCommand,
    decodeAdminPruneCommand,
    decodeAdminPruneWork,
    type AdminPruneExpiredRepository,
} from '@shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts';

const NOW = 1_700_000_000_000;

describe('AdminPruneExpiredWork', () => {
    it('exactly decodes bounded single-category prune commands', async () => {
        const command = await createAdminPruneCommand({
            jobId: 'prune-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            dryRun: false,
            categories: ['runtime-state', 'resource-inbox-results'],
            appData: null,
            pageSize: 2,
        });

        expect(decodeAdminPruneCommand(command)).toEqual(command);
        expect(command.categories).toEqual(['runtime-state', 'resource-inbox-results']);
        expect(() => decodeAdminPruneCommand({
            ...command,
            categories: ['unknown'],
        })).toThrow(TypeError);
        expect(() => decodeAdminPruneCommand({
            ...command,
            pageSize: 0,
        })).toThrow(TypeError);
    });

    it('reads and deletes at most one configured page for one category', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        const work = new AdminPruneExpiredWork({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
        });
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-1',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null,
        });
        const command = decodeAdminPruneWork(entry);
        const read = await work.read(command);
        const computed = work.compute(command, read);

        work.validate(command, read, computed);
        expect(read.rowIds).toEqual(['1', '2']);
        expect(computed).toMatchObject({
            kind: 'page',
            category: 'runtime-state',
            deletedRows: 2,
            next: {
                kind: 'page',
                afterCursor: '2',
                pageIndex: 1,
            },
        });

        await work.write(repository.transaction, computed, entry);

        expect(repository.deleted).toEqual(['1', '2']);
        expect(repository.writtenEntries).toHaveLength(1);
        expect(repository.finished).toEqual([entry.key]);
    });

    it('excludes the currently executing resource-inbox row from its page', async () => {
        const repository = new MemoryPruneRepository(['10', '11', '12']);
        const work = new AdminPruneExpiredWork({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 3,
            now: () => NOW,
        });
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-queue',
            category: 'resource-inbox',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 3,
            afterCursor: null,
            pageIndex: 0,
            appData: null,
        }, '11');

        const command = decodeAdminPruneWork(entry);
        const read = await work.read(command);

        expect(repository.lastExcludedResourceId).toBe(entry.key.resourceId);
        expect(read.rowIds).toEqual(['10', '12']);
    });

    it('rolls deletion and successor back when reservation fencing fails', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        repository.loseReservation = true;
        const work = new AdminPruneExpiredWork({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
        });
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-rollback',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null,
        });

        await expect(work.processReservedEntry(entry)).rejects.toThrow(/reservation/i);
        expect(repository.deleted).toEqual([]);
        expect(repository.writtenEntries).toEqual([]);
    });

    it('rejects forged multi-category work and page-size widening', () => {
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-forged',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null,
            categories: ['runtime-state', 'app-data'],
        } as never);
        expect(() => decodeAdminPruneWork(entry)).toThrow(TypeError);

        const widened = createReservedEntry({
            kind: 'page',
            jobId: 'prune-wide',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 10_000,
            afterCursor: null,
            pageIndex: 0,
            appData: null,
        });
        expect(() => decodeAdminPruneWork(widened)).toThrow(TypeError);
    });
});

class MemoryPruneRepository implements AdminPruneExpiredRepository {
    readonly transaction = (() => undefined) as never;
    readonly database = Object.assign((() => undefined) as never, {
        begin: async <T>(write: (transaction: never) => Promise<T>) => {
            const beforeDeleted = [...this.deleted];
            const beforeEntries = [...this.writtenEntries];
            try {
                return await write(this.transaction);
            } catch (error) {
                this.deleted.splice(0, this.deleted.length, ...beforeDeleted);
                this.writtenEntries.splice(0, this.writtenEntries.length, ...beforeEntries);
                throw error;
            }
        },
    });
    readonly deleted: string[] = [];
    readonly writtenEntries: ResourceEntry[] = [];
    readonly finished: ResourceEntry['key'][] = [];
    lastExcludedResourceId: string | null = null;
    loseReservation = false;

    constructor(private readonly rowIds: readonly string[]) {}

    readPage(input: { pageSize: number; excludedResourceId: string | null }) {
        this.lastExcludedResourceId = input.excludedResourceId;
        const selected = this.rowIds
            .filter((id) => id !== input.excludedResourceId)
            .slice(0, input.pageSize);
        return Promise.resolve({
            rowIds: selected,
            hasMore: this.rowIds.length > selected.length,
        });
    }

    deletePage(_transaction: never, _command: unknown, rowIds: readonly string[]) {
        this.deleted.push(...rowIds);
        return Promise.resolve(rowIds.length);
    }

    writeOutbox(_transaction: never, entry: ResourceEntry) {
        this.writtenEntries.push(entry);
        return Promise.resolve();
    }

    writeProgress() {
        return Promise.resolve();
    }

    finishReserved(_transaction: never, entry: ResourceEntry) {
        if (this.loseReservation) return Promise.resolve(false);
        this.finished.push(entry.key);
        return Promise.resolve(true);
    }
}

function createReservedEntry(work: unknown, resourceId = 'prune-work-1'): ResourceEntry {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(NOW)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key: {
            topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
            resourceId,
            contextId: 'prune-job',
        },
        resource: JSON.stringify({
            id: { v: 2, msgId: resourceId, ts: NOW, senderId: 'server-1' },
            route: {
                topicId: ADMIN_PRUNE_APP_OUTBOX_TOPIC,
                resourceId,
                contextId: 'prune-job',
            },
            targets: { mode: 'all', scope: 'global' },
            constraints: { expiresAtMs: NOW + 60_000 },
            payload: {
                typeId: 'ADMIN_PRUNE_EXPIRED',
                contentType: 'application/json',
                resource: JSON.stringify(work),
            },
            audit: { createdBy: 'server-1', createdTs: NOW },
        }),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.RESERVED,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'app:server-1',
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(NOW + 60_000),
        },
        dequeueAudit: {
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW),
            attempts: 1,
        },
    };
}
