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
import { validateComputedProjection } from '../../computed-data-validation.ts';
import { serializeCanonicalJson } from '../../protocol/canonical-json.ts';
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
    type AdminPruneAggregate
} from './admin-prune-progress.ts';

export interface AdminPruneCandidate {
    readonly rowId: string;
    readonly revisionToken: string;
}

export interface AdminPruneCandidatePage {
    readonly candidates: readonly AdminPruneCandidate[];
    readonly hasMore: boolean;
}

export interface AdminPrunePageRead extends AdminPruneCandidatePage {
    readonly aggregate: AdminPruneAggregate;
    readonly expectedAggregate: string;
    readonly authority: Readonly<{ allowed: boolean; code: string; }>;
    readonly nowEpochMs: number;
    readonly serviceId: string;
}

interface AdminPrunePageDeleteBase {
    readonly candidates: readonly AdminPruneCandidate[];
    readonly candidateRowsJson: string;
    readonly capturedAt: Date;
}

export type AdminPrunePageDelete =
    | Readonly<AdminPrunePageDeleteBase & { category: 'runtime-state'; }>
    | Readonly<AdminPrunePageDeleteBase & { category: 'resource-inbox'; }>
    | Readonly<AdminPrunePageDeleteBase & { category: 'resource-inbox-results'; }>
    | Readonly<AdminPrunePageDeleteBase & { category: 'app-data'; appData: AdminPruneAppData; }>;

export interface AdminPruneProgressWrite {
    readonly expectedAggregate: string;
    readonly aggregateSuccessor: ResourceEntry;
    readonly aggregateSuccessorExpiryAtIsoTimestamp: string;
}

export interface AdminPrunePageComputed extends AdminPruneProgressWrite {
    readonly kind: 'page';
    readonly jobId: string;
    readonly category: AdminPruneExpiredCategory;
    readonly rowIds: readonly string[];
    readonly deletedRows: number;
    readonly deletion: AdminPrunePageDelete;
    readonly next: AdminPrunePageWork | null;
    readonly successorOutboxWrite: AppOutboxInsert | null;
    readonly reservationFinish: ResourceInboxReservationFinish;
}

export interface AdminPrunePageValidationIssue {
    readonly code: 'admin-prune-authority-denied' | 'admin-prune-page-invalid';
    readonly message: string;
    readonly status: number;
    readonly cause: Error;
}

export interface AdminPrunePageRepository {
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
}

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
        const cursor = read.candidates.at(-1)?.rowId ?? command.afterCursor;
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
        const deletion = toAdminPrunePageDelete(command, read.candidates);
        const rowIds = deletion.candidates.map((candidate) => candidate.rowId);
        const page = {
            kind: 'page',
            jobId: command.jobId,
            category: command.category,
            rowIds,
            deletedRows: rowIds.length,
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
    ): readonly AdminPrunePageValidationIssue[] {
        const issues: AdminPrunePageValidationIssue[] = [];
        if (
            !read.authority.allowed ||
            command.expireAtEpochMs <= read.nowEpochMs ||
            read.aggregate.requestedBy !== command.requestedBy ||
            read.aggregate.requestedSessionId !== command.requestedSessionId
        ) {
            const cause = Object.assign(new Error('Admin prune current authority is denied'), {
                code: 'admin-prune-authority-denied',
                status: 403
            });
            issues.push({
                code: 'admin-prune-authority-denied',
                message: cause.message,
                status: 403,
                cause
            });
        }
        if (read.candidates.length > command.pageSize) {
            const cause = new TypeError('Admin prune computed page exceeds its command');
            issues.push({
                code: 'admin-prune-page-invalid',
                message: cause.message,
                status: 400,
                cause
            });
        }
        const expected = this.compute(command, read);
        issues.push(
            ...validateComputedProjection(expected, computed, 'computed').map((issue) => ({
                code: 'admin-prune-page-invalid' as const,
                message: issue.message,
                status: 400,
                cause: issue.cause
            }))
        );
        return issues;
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
        const issues = this.validate(command, read, computed);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        await runInPSqlTransaction(this.options.database, async (transaction) => {
            await this.write(transaction, computed);
        });
        this.options.wakeQueue?.();
    }
}

export function toAdminPrunePageDelete(
    command: AdminPrunePageWork,
    candidates: readonly AdminPruneCandidate[]
): AdminPrunePageDelete {
    const observedCandidates = candidates.map((candidate) => ({ ...candidate }));
    const base = {
        candidates: observedCandidates,
        candidateRowsJson: serializeCanonicalJson(observedCandidates),
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
