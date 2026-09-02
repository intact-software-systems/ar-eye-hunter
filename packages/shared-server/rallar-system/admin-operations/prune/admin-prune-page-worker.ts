import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '../../../postgres/run-in-p-sql-transaction.ts';
import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
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
        serviceId: string;
    }>;

interface AdminPrunePageDeleteBase {
    readonly rowIds: readonly string[];
    readonly capturedAt: Date;
}

export type AdminPrunePageDelete =
    | Readonly<AdminPrunePageDeleteBase & { category: 'runtime-state'; }>
    | Readonly<AdminPrunePageDeleteBase & { category: 'resource-inbox'; }>
    | Readonly<AdminPrunePageDeleteBase & { category: 'resource-inbox-results'; }>
    | Readonly<AdminPrunePageDeleteBase & { category: 'app-data'; appData: AdminPruneAppData; }>;

export type AdminPruneProgressWrite = Readonly<{
    expectedAggregate: string;
    aggregateSuccessor: ResourceEntry;
    aggregateSuccessorExpiryAtIsoTimestamp: string;
}>;

export type AdminPrunePageComputed =
    & AdminPruneProgressWrite
    & Readonly<{
        kind: 'page';
        jobId: string;
        category: AdminPruneExpiredCategory;
        rowIds: readonly string[];
        deletedRows: number;
        deletion: AdminPrunePageDelete;
        next: AdminPrunePageWork | null;
        successorOutboxWrite: AppOutboxInsert | null;
        reservationFinish: ResourceInboxReservationFinish;
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
        transaction: PSqlSql,
        deletion: AdminPrunePageDelete
    ): Promise<number>;
    writeOutbox(transaction: PSqlSql, computed: AppOutboxInsert): Promise<void>;
    writeProgress(
        transaction: PSqlSql,
        computed: AdminPruneProgressWrite
    ): Promise<void>;
    finishReserved(
        transaction: PSqlSql,
        completion: ResourceInboxReservationFinish
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
            nowEpochMs,
            serviceId: this.options.serviceId
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
        const deletion = toAdminPrunePageDelete(command, read.rowIds);
        const page = {
            kind: 'page',
            jobId: command.jobId,
            category: command.category,
            rowIds: deletion.rowIds,
            deletedRows: deletion.rowIds.length,
            deletion,
            next
        } as const;
        const aggregate = advanceAdminPruneAggregate(read.aggregate, page);
        const aggregateSuccessor = toAdminPruneAggregateEntry(
            {
                ...aggregate,
                expireAtEpochMs: Math.max(
                    aggregate.expireAtEpochMs,
                    resourceInboxRetryExpiryAtEpochMs(read.nowEpochMs)
                )
            }
        );
        return {
            ...page,
            successorOutboxWrite: next
                ? computeAppOutboxInsert(toAdminPruneOutbox(next, read.serviceId))
                : null,
            expectedAggregate: read.expectedAggregate,
            aggregateSuccessor,
            aggregateSuccessorExpiryAtIsoTimestamp: aggregateSuccessor.audit.expiryTs.toString(),
            reservationFinish: {
                key: command.reservation.key,
                expectedAttempts: command.reservation.dequeueAudit.attempts,
                status: EntityStatus.COMPLETED,
                completedAt: new Date(read.nowEpochMs)
            }
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
        if (
            computed.deletion.category !== command.category ||
            computed.deletion.rowIds.length !== read.rowIds.length ||
            computed.deletion.capturedAt.getTime() !== command.capturedAtEpochMs ||
            (computed.next === null) !== (computed.successorOutboxWrite === null) ||
            computed.reservationFinish.expectedAttempts !== command.reservation.dequeueAudit.attempts ||
            computed.reservationFinish.completedAt.getTime() !== read.nowEpochMs
        ) {
            throw new TypeError('Admin prune computed persistence differs from read facts');
        }
    }

    async write(
        transaction: PSqlSql,
        computed: AdminPrunePageComputed
    ): Promise<void> {
        await this.options.repository.writeProgress(transaction, computed);
        const deleted = await this.options.repository.deletePage(transaction, computed.deletion);
        if (deleted !== computed.deletedRows) {
            throw new Error('Admin prune page changed before delete');
        }
        if (computed.successorOutboxWrite !== null) {
            await this.options.repository.writeOutbox(transaction, computed.successorOutboxWrite);
        }
        if (!await this.options.repository.finishReserved(transaction, computed.reservationFinish)) {
            throw new Error('Admin prune reservation changed before commit');
        }
    }

    async processReservedEntry(entry: ResourceEntry): Promise<void> {
        const command = decodeAdminPruneWork(entry);
        const read = await this.read(command);
        const computed = this.compute(command, read);
        this.validate(command, read, computed);
        await runInPSqlTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed);
        });
        this.options.wakeQueue?.();
    }
}

export function toAdminPrunePageDelete(
    command: AdminPrunePageWork,
    rowIds: readonly string[]
): AdminPrunePageDelete {
    const base = {
        rowIds: [...rowIds],
        capturedAt: new Date(command.capturedAtEpochMs)
    };
    switch (command.category) {
        case 'runtime-state':
        case 'resource-inbox':
        case 'resource-inbox-results':
            return { ...base, category: command.category };
        case 'app-data':
            if (!command.appData) {
                throw new TypeError('App-data prune requires namespace');
            }
            return { ...base, category: command.category, appData: command.appData };
    }
}
