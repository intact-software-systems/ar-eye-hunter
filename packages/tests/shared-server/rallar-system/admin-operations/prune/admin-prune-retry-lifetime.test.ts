import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    toAdminPruneOutbox,
    type AdminPrunePageWork,
    type ReservedAdminPrunePageWork
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import {
    AdminPrunePageWorker,
    type AdminPrunePageRead,
    type AdminPrunePageRepository
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts';
import {
    createAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneCompletedResult
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts';
import { classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS,
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
    retryAfterAttempt
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';

const NOW = 1_700_000_000_000;
const RETRY_LIFETIME = DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS + RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS;

describe('admin prune retry lifetime', () => {
    it('gives every successor and pending result a complete 20-attempt retry horizon', () => {
        const service = new AdminPrunePageWorker({
            database: createDatabase(),
            repository: createRepository(),
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' })
        });
        const command = createReservedCommand();
        const aggregate = createAdminPruneAggregate({
            jobId: command.jobId,
            generatedAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: command.expireAtEpochMs,
            serverId: 'server-1',
            requestedBy: command.requestedBy,
            requestedSessionId: command.requestedSessionId,
            categories: [command.category],
            expiredRows: { 'runtime-state': 3 }
        });
        const read: AdminPrunePageRead = {
            candidates: [
                { rowId: '1', revisionToken: '1' },
                { rowId: '2', revisionToken: '2' }
            ],
            hasMore: true,
            aggregate,
            expectedAggregate: JSON.stringify(aggregate),
            authority: { allowed: true, code: 'allowed' },
            nowEpochMs: NOW,
            serviceId: 'server-1'
        };

        const computed = service.compute(command, read);

        expect(computed.next?.expireAtEpochMs).toBe(NOW + RETRY_LIFETIME);
        expect(Number(computed.aggregateSuccessor.audit.expiryTs.epochMilliseconds)).toBe(NOW + RETRY_LIFETIME);
    });

    it('rereads the complete attempt after every conflict and leaves the caller result pending at exhaustion', async () => {
        const aggregate = createAdminPruneAggregate({
            jobId: 'retry-exhaustion-job',
            generatedAtEpochMs: NOW - 1,
            expireAtEpochMs: NOW + RETRY_LIFETIME,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 2 }
        });
        const calls = {
            authorityReads: 0,
            pageReads: 0,
            aggregateReads: 0,
            progressWrites: 0,
            deletes: 0,
            outboxWrites: 0,
            finishes: 0,
            wakes: 0
        };
        const transaction = (() => undefined) as never;
        const database = Object.assign((() => undefined) as never, {
            begin: async <T>(write: (sql: PSqlSql) => Promise<T>): Promise<T> => await write(transaction)
        }) as PSqlSql;
        const repository: AdminPrunePageRepository = {
            readPage: () => {
                calls.pageReads += 1;
                return Promise.resolve({
                    candidates: [
                        { rowId: '1', revisionToken: '1' },
                        { rowId: '2', revisionToken: '2' }
                    ],
                    hasMore: false
                });
            },
            readAggregate: () => {
                calls.aggregateReads += 1;
                return Promise.resolve({
                    aggregate,
                    resource: toAdminPruneAggregateEntry(aggregate).resource
                });
            },
            writeProgress: () => {
                calls.progressWrites += 1;
                throw Object.assign(new Error('Admin prune aggregate changed before commit'), {
                    code: 'admin-prune-progress-conflict'
                });
            },
            deletePage: () => {
                calls.deletes += 1;
                return Promise.resolve(2);
            },
            writeOutbox: () => {
                calls.outboxWrites += 1;
                return Promise.resolve();
            },
            finishReserved: () => {
                calls.finishes += 1;
                return Promise.resolve(true);
            }
        };
        const worker = new AdminPrunePageWorker({
            database,
            repository,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => {
                calls.authorityReads += 1;
                return Promise.resolve({ allowed: true, code: 'allowed' });
            },
            wakeQueue: () => {
                calls.wakes += 1;
            }
        });
        const classifications = [];
        const retryDecisions = [];

        for (let attempt = 1; attempt <= DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts; attempt += 1) {
            try {
                await worker.processReservedEntry(createRetryEntry(attempt));
                throw new Error('Expected admin prune progress conflict');
            }
            catch (error) {
                classifications.push(classifyAppInboxError(error));
                retryDecisions.push(retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, attempt, 0.5));
            }
        }

        expect(classifications).toHaveLength(DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts);
        expect(classifications).toEqual(
            classifications.map(() =>
                expect.objectContaining({
                    kind: 'retryable',
                    code: 'admin-prune-progress-conflict'
                })
            )
        );
        expect(retryDecisions.at(-1)).toEqual({ status: 'failed', delayMs: null });
        expect(calls).toEqual({
            authorityReads: 20,
            pageReads: 20,
            aggregateReads: 20,
            progressWrites: 20,
            deletes: 0,
            outboxWrites: 0,
            finishes: 0,
            wakes: 0
        });
        const pendingResult = toAdminPruneAggregateEntry(aggregate);
        expect(pendingResult.status).toBe(EntityStatus.NEW);
        expect(() => toAdminPruneCompletedResult(aggregate)).toThrow(
            'Admin prune aggregate is incomplete'
        );
    });
});

function createRetryEntry(attempts: number): ResourceEntry {
    const work: AdminPrunePageWork = {
        kind: 'page',
        jobId: 'retry-exhaustion-job',
        category: 'runtime-state',
        requestedBy: 'admin-1',
        requestedSessionId: 'session-1',
        capturedAtEpochMs: NOW - 1,
        expireAtEpochMs: NOW + RETRY_LIFETIME,
        pageSize: 2,
        afterCursor: null,
        pageIndex: 0,
        appData: null
    };
    return {
        ...toAdminPruneOutbox(work, 'server-1'),
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            startTs: Temporal.Instant.fromEpochMilliseconds(NOW),
            attempts
        }
    };
}

function createReservedCommand(): ReservedAdminPrunePageWork {
    return {
        kind: 'page',
        jobId: 'job-1',
        category: 'runtime-state',
        requestedBy: 'admin-1',
        requestedSessionId: 'session-1',
        capturedAtEpochMs: NOW - 1,
        expireAtEpochMs: NOW + RETRY_LIFETIME,
        pageSize: 2,
        afterCursor: null,
        pageIndex: 0,
        appData: null,
        reservation: createReservation()
    };
}

function createReservation(): ResourceEntry {
    return {
        key: { topicId: 'admin-prune', resourceId: 'job-1', contextId: 'runtime-state' },
        resource: '{}',
        typeId: 'APP_OUTBOX',
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: 'server-1',
            createdTs: Temporal.PlainDateTime.from('2023-11-14T00:00:00'),
            expiryTs: Temporal.Instant.fromEpochMilliseconds(NOW + RETRY_LIFETIME)
        },
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 }
    };
}

function createDatabase(): PSqlSql {
    const database: PSqlSql = Object.assign(
        <T>(
            _stringsOrValues: TemplateStringsArray | Parameters<PSqlSql>[0],
            ..._values: Parameters<PSqlSql>[0]
        ): Promise<T> => Promise.reject(new Error('Unexpected SQL execution in admin prune compute test')),
        {
            begin: <T>(_run: (sql: PSqlSql) => Promise<T>): Promise<T> => Promise.reject(new Error('Unexpected transaction in admin prune compute test'))
        }
    );
    return database;
}

function createRepository(): AdminPrunePageRepository {
    return {
        readPage: () => Promise.reject(new Error('not read')),
        readAggregate: () => Promise.reject(new Error('not read')),
        deletePage: () => Promise.reject(new Error('not written')),
        writeOutbox: () => Promise.reject(new Error('not written')),
        writeProgress: () => Promise.reject(new Error('not written')),
        finishReserved: () => Promise.reject(new Error('not written'))
    };
}
