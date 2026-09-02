import { Temporal } from '@js-temporal/polyfill';
import type { ResourceInboxReservationFinish } from '@shared-server/queuebox/postgres/resource-inbox-reservation-write.ts';
import { createAdminPruneCommand, decodeAdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import {
    ADMIN_PRUNE_APP_OUTBOX_TOPIC,
    decodeAdminPruneWork,
    toAdminPruneOutbox,
    type AdminPrunePageWork
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import {
    AdminPrunePageWorker,
    type AdminPrunePageDelete,
    type AdminPrunePageRepository
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts';
import { createAdminPruneAggregate, toAdminPruneAggregateEntry } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';
import type { AppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { describe, expect, it } from 'vitest';

const NOW = 1_700_000_000_000;

describe('AdminPrunePageWorker', () => {
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
            pageSize: 2
        });

        expect(decodeAdminPruneCommand(command)).toEqual(command);
        expect(command.categories).toEqual(['runtime-state', 'resource-inbox-results']);
        expect(() =>
            decodeAdminPruneCommand({
                ...command,
                categories: ['unknown']
            })
        ).toThrow(TypeError);
        expect(() =>
            decodeAdminPruneCommand({
                ...command,
                pageSize: 0
            })
        ).toThrow(TypeError);
    });

    it('reads and deletes at most one configured page for one category', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
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
            appData: null
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
                pageIndex: 1
            }
        });

        await work.write(repository.transaction, computed);

        expect(repository.deleted).toEqual(['1', '2']);
        expect(repository.calls[0]).toBe('progress');
        expect(repository.writtenEntries).toHaveLength(1);
        expect(repository.finished).toEqual([entry.key]);
        expect(computed.next?.expireAtEpochMs).toBe(resourceInboxRetryExpiryAtEpochMs(NOW));
    });

    it('excludes the currently executing resource-inbox row from its page', async () => {
        const repository = new MemoryPruneRepository(['10', '11', '12']);
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 3,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
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
            appData: null
        });

        const command = decodeAdminPruneWork(entry);
        const read = await work.read(command);

        expect(repository.lastExcludedResourceKey).toEqual(entry.key);
        expect(read.rowIds).toEqual(['10', '11', '12']);
    });

    it('rolls deletion and successor back when reservation fencing fails', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        repository.loseReservation = true;
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
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
            appData: null
        });

        await expect(work.processReservedEntry(entry)).rejects.toThrow(/reservation/i);
        expect(repository.deleted).toEqual([]);
        expect(repository.writtenEntries).toEqual([]);
    });

    it('does not write or wake when current page authority is denied', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        let wakeCount = 0;
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: false, code: 'session-revoked' }),
            wakeQueue: () => {
                wakeCount += 1;
            }
        });

        await expect(work.processReservedEntry(createReservedEntry({
            kind: 'page',
            jobId: 'prune-denied',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }))).rejects.toMatchObject({ code: 'admin-prune-authority-denied', status: 403 });

        expect(repository.deleted).toEqual([]);
        expect(repository.writtenEntries).toEqual([]);
        expect(repository.finished).toEqual([]);
        expect(repository.progressWrites).toBe(0);
        expect(wakeCount).toBe(0);
    });

    it('rolls aggregate, deletion, successor, and reservation back on outbox collision', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        repository.rejectOutbox = true;
        let wakeCount = 0;
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' }),
            wakeQueue: () => {
                wakeCount += 1;
            }
        });

        await expect(work.processReservedEntry(createReservedEntry({
            kind: 'page',
            jobId: 'prune-outbox-collision',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }))).rejects.toThrow(/outbox collision/i);

        expect(repository.deleted).toEqual([]);
        expect(repository.writtenEntries).toEqual([]);
        expect(repository.finished).toEqual([]);
        expect(repository.progressWrites).toBe(0);
        expect(wakeCount).toBe(0);
    });

    it('rolls every page effect back when commit fails', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        repository.rejectCommit = true;
        let wakeCount = 0;
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' }),
            wakeQueue: () => {
                wakeCount += 1;
            }
        });

        await expect(work.processReservedEntry(createReservedEntry({
            kind: 'page',
            jobId: 'prune-commit-failure',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        }))).rejects.toThrow(/commit failed/i);

        expect(repository.deleted).toEqual([]);
        expect(repository.writtenEntries).toEqual([]);
        expect(repository.finished).toEqual([]);
        expect(repository.progressWrites).toBe(0);
        expect(wakeCount).toBe(0);
    });

    it('rereads page, aggregate predecessor, and authority after a progress conflict', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        repository.rejectProgressOnce = true;
        let authorityReads = 0;
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => {
                authorityReads += 1;
                return Promise.resolve({ allowed: true, code: 'allowed' });
            }
        });
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-progress-retry',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        });

        await expect(work.processReservedEntry(entry)).rejects.toMatchObject({
            code: 'admin-prune-progress-conflict'
        });
        await work.processReservedEntry(entry);

        expect(repository.readPageCalls).toBe(2);
        expect(repository.readAggregateCalls).toBe(2);
        expect(authorityReads).toBe(2);
        expect(repository.deleted).toEqual(['1', '2']);
        expect(repository.progressWrites).toBe(1);
    });

    it('wakes the queue only after committed successor page work', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        let wakeCount = 0;
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' }),
            wakeQueue: () => {
                wakeCount += 1;
            }
        });
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-successor',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        });

        await work.processReservedEntry(entry);

        expect(repository.writtenEntries).toHaveLength(1);
        expect(wakeCount).toBe(1);
    });

    it('extends pending aggregate and successor expiry from the page read time', async () => {
        const repository = new MemoryPruneRepository(['1', '2', '3']);
        const work = new AdminPrunePageWorker({
            database: repository.database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW + 50_000,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
        });
        const entry = createReservedEntry({
            kind: 'page',
            jobId: 'prune-expiry',
            category: 'runtime-state',
            capturedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 120_000,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null
        });

        const command = decodeAdminPruneWork(entry);
        const computed = work.compute(command, await work.read(command));

        expect(computed.next?.expireAtEpochMs).toBe(resourceInboxRetryExpiryAtEpochMs(NOW + 50_000));
        expect(computed.aggregateSuccessor.audit.expiryTs.epochMilliseconds).toBe(
            resourceInboxRetryExpiryAtEpochMs(NOW + 50_000)
        );
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
            categories: ['runtime-state', 'app-data']
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
            appData: null
        });
        expect(() => decodeAdminPruneWork(widened)).toThrow(TypeError);
    });
});

class MemoryPruneRepository implements AdminPrunePageRepository {
    readonly transaction = (() => undefined) as never;
    readonly database = Object.assign((() => undefined) as never, {
        begin: async <T>(write: (transaction: never) => Promise<T>) => {
            const beforeDeleted = [...this.deleted];
            const beforeEntries = [...this.writtenEntries];
            const beforeFinished = [...this.finished];
            const beforeProgressWrites = this.progressWrites;
            try {
                const result = await write(this.transaction);
                if (this.rejectCommit) {
                    throw new Error('Admin prune commit failed');
                }
                return result;
            }
            catch (error) {
                this.deleted.splice(0, this.deleted.length, ...beforeDeleted);
                this.writtenEntries.splice(0, this.writtenEntries.length, ...beforeEntries);
                this.finished.splice(0, this.finished.length, ...beforeFinished);
                this.progressWrites = beforeProgressWrites;
                throw error;
            }
        }
    });
    readonly deleted: string[] = [];
    readonly writtenEntries: Array<Readonly<ResourceEntry>> = [];
    readonly finished: ResourceEntry['key'][] = [];
    readonly calls: string[] = [];
    lastExcludedResourceKey: ResourceEntry['key'] | null = null;
    loseReservation = false;
    progressWrites = 0;
    readAggregateCalls = 0;
    readPageCalls = 0;
    rejectCommit = false;
    rejectOutbox = false;
    rejectProgressOnce = false;

    private readonly rowIds: readonly string[];

    constructor(rowIds: readonly string[]) {
        this.rowIds = rowIds;
    }

    readPage(input: { pageSize: number; excludedResourceKey: ResourceEntry['key'] | null; }) {
        this.readPageCalls += 1;
        this.lastExcludedResourceKey = input.excludedResourceKey;
        const selected = this.rowIds
            .slice(0, input.pageSize);
        return Promise.resolve({
            rowIds: selected,
            hasMore: this.rowIds.length > selected.length
        });
    }

    readAggregate(jobId: string) {
        this.readAggregateCalls += 1;
        const aggregate = createAdminPruneAggregate({
            jobId,
            generatedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state', 'resource-inbox', 'resource-inbox-results', 'app-data'],
            expiredRows: {
                'runtime-state': 3,
                'resource-inbox': 3,
                'resource-inbox-results': 3,
                'app-data': 3
            }
        });
        const entry = toAdminPruneAggregateEntry(aggregate);
        return Promise.resolve({ aggregate, resource: entry.resource });
    }

    deletePage(_transaction: never, deletion: AdminPrunePageDelete) {
        this.calls.push('delete');
        this.deleted.push(...deletion.rowIds);
        return Promise.resolve(deletion.rowIds.length);
    }

    writeOutbox(_transaction: never, computed: AppOutboxInsert) {
        this.calls.push('outbox');
        this.writtenEntries.push(computed.entry);
        if (this.rejectOutbox) {
            throw new Error('Admin prune outbox collision');
        }
        return Promise.resolve();
    }

    writeProgress() {
        this.calls.push('progress');
        this.progressWrites += 1;
        if (this.rejectProgressOnce) {
            this.rejectProgressOnce = false;
            throw Object.assign(new Error('Admin prune aggregate changed before commit'), {
                code: 'admin-prune-progress-conflict'
            });
        }
        return Promise.resolve();
    }

    finishReserved(_transaction: never, completion: ResourceInboxReservationFinish) {
        if (this.loseReservation) {
            return Promise.resolve(false);
        }
        this.finished.push(completion.key);
        return Promise.resolve(true);
    }
}

function createReservedEntry(
    work: Omit<AdminPrunePageWork, 'requestedBy' | 'requestedSessionId'>
): ResourceEntry {
    const normalized: AdminPrunePageWork = {
        ...work,
        requestedBy: 'admin-1',
        requestedSessionId: 'session-1'
    };
    const entry = toAdminPruneOutbox(normalized, 'server-1');
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW),
            attempts: 1
        }
    };
}
