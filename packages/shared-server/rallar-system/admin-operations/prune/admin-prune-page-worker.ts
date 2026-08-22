import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlSql, PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { runInTransaction } from '../../../postgres/run-in-transaction.ts';
import { requireAdminPrunePageSize, type AdminPruneAppData } from '../inbox/admin-prune-command-codec.ts';
import {
    decodeAdminPruneWork,
    toAdminPruneOutbox,
    type AdminPrunePageWork,
    type ReservedAdminPrunePageWork
} from './admin-prune-page-codec.ts';
import {
    advanceAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey,
    type AdminPruneAggregate
} from './admin-prune-progress.ts';

export type AdminPruneCandidatePage = Readonly<{
    rowIds: readonly string[];
    hasMore: boolean;
}>;

export type AdminPrunePageRead =
    & AdminPruneCandidatePage
    & Readonly<{
        aggregate: AdminPruneAggregate;
        expectedAggregate: string;
        authority: Readonly<{ allowed: boolean; code: string; }>;
        nowEpochMs: number;
    }>;

export type AdminPrunePageComputed = Readonly<{
    kind: 'page';
    jobId: string;
    category: AdminPruneExpiredCategory;
    rowIds: readonly string[];
    deletedRows: number;
    next: AdminPrunePageWork | null;
    expectedAggregate: string;
    aggregateSuccessor: ResourceEntry;
    finishedAtEpochMs: number;
}>;

export type AdminPrunePageRepository = Readonly<{
    readPage(
        input: Readonly<{
            category: AdminPruneExpiredCategory;
            pageSize: number;
            afterCursor: string | null;
            expireAtEpochMs: number;
            appData: AdminPruneAppData | null;
            excludedResourceKey: Key | null;
        }>
    ): Promise<AdminPruneCandidatePage>;
    readAggregate(jobId: string): Promise<
        Readonly<{
            aggregate: AdminPruneAggregate;
            resource: string;
        }>
    >;
    deletePage(
        transaction: PSqlTransactionSql,
        command: AdminPrunePageWork,
        rowIds: readonly string[]
    ): Promise<number>;
    writeOutbox(transaction: PSqlTransactionSql, entry: ResourceEntry): Promise<void>;
    writeProgress(
        transaction: PSqlTransactionSql,
        computed: AdminPrunePageComputed
    ): Promise<void>;
    finishReserved(
        transaction: PSqlTransactionSql,
        entry: ResourceEntry,
        finishedAtEpochMs: number
    ): Promise<boolean>;
}>;

export interface AdminPrunePageWorkerOptions {
    readonly database: PSqlSql;
    readonly repository: AdminPrunePageRepository;
    readonly serviceId: string;
    readonly pageSize: number;
    readonly now?: () => number;
    readonly readAuthority: (
        input: Readonly<{
            requestedBy: string;
            requestedSessionId: string;
            nowEpochMs: number;
        }>
    ) => Promise<Readonly<{ allowed: boolean; code: string; }>>;
    readonly wakeQueue?: () => void;
}

export class AdminPrunePageWorker {
    private readonly pageSize: number;
    private readonly now: () => number;

    private readonly options: AdminPrunePageWorkerOptions;

    constructor(options: AdminPrunePageWorkerOptions) {
        this.options = options;
        this.pageSize = requireAdminPrunePageSize(options.pageSize);
        this.now = options.now ?? (() => Date.now());
    }

    async read(command: ReservedAdminPrunePageWork): Promise<AdminPrunePageRead> {
        if (command.pageSize > this.pageSize) {
            throw new TypeError('Admin prune page exceeds configured size');
        }
        const nowEpochMs = this.now();
        const [page, aggregateRead, authority] = await Promise.all([
            this.options.repository.readPage({
                category: command.category,
                pageSize: command.pageSize,
                afterCursor: command.afterCursor,
                expireAtEpochMs: command.capturedAtEpochMs,
                appData: command.appData,
                excludedResourceKey: command.category === 'resource-inbox'
                    ? command.reservation.key
                    : null
            }),
            this.options.repository.readAggregate(command.jobId),
            this.options.readAuthority({
                requestedBy: command.requestedBy,
                requestedSessionId: command.requestedSessionId,
                nowEpochMs
            })
        ]);
        return {
            ...page,
            aggregate: aggregateRead.aggregate,
            expectedAggregate: aggregateRead.resource,
            authority,
            nowEpochMs
        };
    }

    compute(
        command: ReservedAdminPrunePageWork,
        read: AdminPrunePageRead
    ): AdminPrunePageComputed {
        if (
            !read.authority.allowed ||
            command.expireAtEpochMs <= read.nowEpochMs ||
            read.aggregate.requestedBy !== command.requestedBy ||
            read.aggregate.requestedSessionId !== command.requestedSessionId
        ) {
            throw Object.assign(new Error('Admin prune current authority is denied'), {
                code: 'admin-prune-authority-denied',
                status: 403
            });
        }
        const cursor = read.rowIds.at(-1) ?? command.afterCursor;
        const next = read.hasMore && cursor !== null
            ? {
                kind: 'page' as const,
                jobId: command.jobId,
                category: command.category,
                requestedBy: command.requestedBy,
                requestedSessionId: command.requestedSessionId,
                capturedAtEpochMs: command.capturedAtEpochMs,
                expireAtEpochMs: resourceInboxRetryExpiryAtEpochMs(read.nowEpochMs),
                pageSize: command.pageSize,
                afterCursor: cursor,
                pageIndex: command.pageIndex + 1,
                appData: command.appData
            }
            : null;
        const page = {
            kind: 'page',
            jobId: command.jobId,
            category: command.category,
            rowIds: read.rowIds,
            deletedRows: read.rowIds.length,
            next
        } as const;
        const aggregate = advanceAdminPruneAggregate(read.aggregate, page);
        return {
            ...page,
            expectedAggregate: read.expectedAggregate,
            aggregateSuccessor: toAdminPruneAggregateEntry(
                {
                    ...aggregate,
                    expireAtEpochMs: Math.max(
                        aggregate.expireAtEpochMs,
                        resourceInboxRetryExpiryAtEpochMs(read.nowEpochMs)
                    )
                }
            ),
            finishedAtEpochMs: read.nowEpochMs
        };
    }

    validate(
        command: ReservedAdminPrunePageWork,
        read: AdminPrunePageRead,
        computed: AdminPrunePageComputed
    ): void {
        const aggregateKey = toAdminPruneAggregateKey(command.jobId);
        if (computed.jobId !== command.jobId || computed.category !== command.category) {
            throw new TypeError('Admin prune computed identity differs from command');
        }
        if (read.rowIds.length > command.pageSize || computed.deletedRows !== read.rowIds.length) {
            throw new TypeError('Admin prune computed page exceeds its command');
        }
        if (
            computed.expectedAggregate !== read.expectedAggregate ||
            computed.aggregateSuccessor.key.topicId !== aggregateKey.topicId ||
            computed.aggregateSuccessor.key.resourceId !== aggregateKey.resourceId ||
            computed.aggregateSuccessor.key.contextId !== aggregateKey.contextId
        ) {
            throw new TypeError('Admin prune computed aggregate differs from read predecessor');
        }
    }

    async write(
        transaction: PSqlTransactionSql,
        computed: AdminPrunePageComputed,
        entry: ResourceEntry
    ): Promise<void> {
        const command = decodeAdminPruneWork(entry);
        await this.options.repository.writeProgress(transaction, computed);
        const deleted = await this.options.repository.deletePage(transaction, command, computed.rowIds);
        if (deleted !== computed.deletedRows) {
            throw new Error('Admin prune page changed before delete');
        }
        if (computed.next) {
            await this.options.repository.writeOutbox(
                transaction,
                toAdminPruneOutbox(computed.next, this.options.serviceId)
            );
        }
        if (
            !await this.options.repository.finishReserved(
                transaction,
                entry,
                computed.finishedAtEpochMs
            )
        ) {
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
