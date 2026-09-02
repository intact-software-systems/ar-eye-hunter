import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlAdminPruneRepository } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-prune-repository.ts';
import {
    decodeAdminPruneWork,
    toAdminPruneOutbox,
    type AdminPrunePageWork
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import {
    AdminPrunePageWorker,
    toAdminPrunePageDelete,
    type AdminPruneProgressWrite
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts';
import {
    createAdminPruneAggregate,
    decodeAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

const NOW = 1_700_000_000_000;

describe('admin prune page persistence invariants', () => {
    it('deletes a bounded page with one conditional SQL statement', async () => {
        const statements: string[] = [];
        const transaction = ((parts: TemplateStringsArray) => {
            statements.push(parts.join('?'));
            return Promise.resolve([{ ri_row_id: 1 }, { ri_row_id: 2 }, { ri_row_id: 3 }]);
        }) as never;
        const repository = new PSqlAdminPruneRepository((() => undefined) as never);
        const deleted = await repository.deletePage(
            transaction,
            toAdminPrunePageDelete(pageWork({ category: 'resource-inbox' }), ['1', '2', '3'])
        );

        expect(deleted).toBe(3);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/with expired|delete from resource_inbox/i);
    });

    it('binds reserved entry route, sender, constraints, audit, and operation to page work', () => {
        const entry = reservedEntry(pageWork());
        const outer = JSON.parse(entry.resource);
        outer.route.contextId = 'another-job';
        outer.id.senderId = 'forged-server';
        outer.constraints.expiresAtMs += 1;
        const forged = { ...entry, resource: JSON.stringify(outer) };

        expect(() => decodeAdminPruneWork(forged)).toThrow(/identity|route|sender|expiry/i);
    });

    it('normalizes UUID-sized job identities for resource-inbox key limits', () => {
        const work = pageWork({ jobId: '123e4567-e89b-12d3-a456-426614174000-long-job-id' });
        const entry = reservedEntry(work);
        const aggregateKey = toAdminPruneAggregateKey(work.jobId);
        const aggregate = createAdminPruneAggregate({
            jobId: work.jobId,
            generatedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            serverId: 'server-1',
            requestedBy: work.requestedBy,
            requestedSessionId: work.requestedSessionId,
            categories: [work.category],
            expiredRows: { [work.category]: 0 }
        });
        const service = new AdminPrunePageWorker({
            database: {} as never,
            repository: {} as never,
            serviceId: 'server-1',
            pageSize: 3,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
        });
        const command = decodeAdminPruneWork(entry);
        const read = {
            rowIds: [],
            hasMore: false,
            aggregate,
            expectedAggregate: JSON.stringify(aggregate),
            authority: { allowed: true, code: 'allowed' },
            nowEpochMs: NOW,
            serviceId: 'server-1'
        } as const;
        const computed = service.compute(command, read);

        expect(entry.key.resourceId.length).toBeLessThanOrEqual(36);
        expect(entry.key.contextId.length).toBeLessThanOrEqual(35);
        expect(aggregateKey.resourceId.length).toBeLessThanOrEqual(36);
        expect(aggregateKey.contextId.length).toBeLessThanOrEqual(35);
        expect(command).toMatchObject(work);
        expect(() => service.validate(command, read, computed)).not.toThrow();
    });

    it('exactly decodes aggregate nested fields and cross-field completion invariants', () => {
        const aggregate = createAdminPruneAggregate({
            jobId: 'job-1',
            generatedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 1 }
        });
        expect(() => decodeAdminPruneAggregate({ ...aggregate, unexpected: true }))
            .toThrow(/field/i);
        expect(() =>
            decodeAdminPruneAggregate({
                ...aggregate,
                status: 'completed',
                completedCategories: []
            })
        ).toThrow(/completion|status/i);
        expect(() =>
            decodeAdminPruneAggregate({
                ...aggregate,
                results: [...aggregate.results, aggregate.results[0]]
            })
        ).toThrow(/duplicate|category/i);
    });

    it('writes the exact computed aggregate successor behind its read predecessor', async () => {
        const aggregate = createAdminPruneAggregate({
            jobId: 'job-progress',
            generatedAtEpochMs: NOW,
            expireAtEpochMs: NOW + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 0 }
        });
        const aggregateSuccessor = {
            ...aggregate,
            revision: 1
        } as const;
        const successorEntry = toAdminPruneAggregateEntry(aggregateSuccessor);
        const computed: AdminPruneProgressWrite = {
            expectedAggregate: JSON.stringify(aggregate),
            aggregateSuccessor: successorEntry,
            aggregateSuccessorExpiryAtIsoTimestamp: successorEntry.audit.expiryTs.toString()
        };
        const boundValues: Array<Parameters<PSqlSql>[0][number]> = [];
        const transaction = ((parts: TemplateStringsArray, ...values: Parameters<PSqlSql>[0]) => {
            boundValues.push(...values);
            return Promise.resolve([{ ris_row_id: 1 }]);
        }) as never;
        const repository = new PSqlAdminPruneRepository((() => undefined) as never);
        const originalToString = Temporal.Instant.prototype.toString;

        Temporal.Instant.prototype.toString = rejectTimestampFormattingDuringWrite;
        try {
            await repository.writeProgress(transaction, computed);
        }
        finally {
            Temporal.Instant.prototype.toString = originalToString;
        }

        expect(boundValues).toContain(successorEntry.resource);
        expect(boundValues).toContain(successorEntry.status);
        expect(boundValues).toContain(successorEntry.key.topicId);
        expect(boundValues).toContain(successorEntry.key.resourceId);
        expect(boundValues).toContain(successorEntry.key.contextId);
        expect(boundValues).toContain(computed.expectedAggregate);
    });
});

function rejectTimestampFormattingDuringWrite(): never {
    throw new TypeError('Admin prune progress timestamp formatted inside write');
}

function pageWork(
    overrides: Partial<AdminPrunePageWork> = {}
): AdminPrunePageWork {
    return {
        kind: 'page',
        jobId: 'job-1',
        category: 'runtime-state',
        requestedBy: 'admin-1',
        requestedSessionId: 'session-1',
        capturedAtEpochMs: NOW,
        expireAtEpochMs: NOW + 60_000,
        pageSize: 3,
        afterCursor: null,
        pageIndex: 0,
        appData: null,
        ...overrides
    };
}

function reservedEntry(work: AdminPrunePageWork): ResourceEntry {
    const entry = toAdminPruneOutbox(work, 'server-1');
    return {
        ...entry,
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW),
            attempts: 1
        }
    };
}
