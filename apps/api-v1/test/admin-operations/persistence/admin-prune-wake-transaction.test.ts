import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createApiAdminInboxService } from '../../../src/admin-operations/create-api-admin-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestQueueResilience } from '../../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from '../../db/pglite-app-inbox-test-runtime.ts';
import {
    readPGliteDatabaseEpochMs,
    withUtcPGliteSql
} from '../../db/pglite-auth-test-harness.ts';
import {
    assertUtcPGliteSession,
    RealEngineAdminPruneFixture
} from './admin-prune-real-engine-fixture.ts';

Deno.test('committed initial admin page work wakes the running queue engine into APP_OUTBOX processing', async () => {
    await withUtcPGliteSql(runRealEngineHandoffTest);
});

Deno.test('initial admin page work does not wake until its successful transaction commits', async () => {
    await withUtcPGliteSql(async (sql) => {
        const fixture = await createDeferredAdminCommitFixture(sql);
        await assertDeferredAdminCommit(fixture, () => assert.equal(fixture.state.wakeCount, 0));
    });
});

Deno.test('failed admin commit assertion joins its held transaction and request before database cleanup', async () => {
    await withUtcPGliteSql(async (sql) => {
        const fixture = await createDeferredAdminCommitFixture(sql);
        const primary = new Error('admin assertion before held commit release');
        try {
            const failure = await assertDeferredAdminCommit(fixture, () => {
                throw primary;
            }).then(
                () => undefined,
                (caught) => toError(caught)
            );
            assert.strictEqual(failure, primary);
            assert.equal(fixture.state.processingCompleted, true, 'Admin assertion escaped before its held real transaction completed');
            assert.equal(fixture.state.commitReleased, true);
            assert.equal(fixture.state.pendingCompleted, true);
        }
        finally {
            // The outer RED test always frees the real database even when the tested owner fails.
            fixture.releaseCommit();
            await Promise.allSettled([fixture.processing, fixture.pending]);
        }
    });
});

interface DeferredAdminCommitGate {
    readonly written: PromiseWithResolvers<void>;
    readonly released: PromiseWithResolvers<void>;
}

interface DeferredAdminCommitFixture {
    readonly sql: PGliteSql;
    readonly inbox: InboxQueueReader;
    readonly outbox: OutboxQueueReader;
    readonly gate: DeferredAdminCommitGate;
    readonly pending: ReturnType<ReturnType<typeof createApiAdminInboxService>['pruneExpired']>;
    processing: ReturnType<InboxQueueReader['dequeueInbox']> | undefined;
    readonly state: {
        wakeCount: number;
        processingCompleted: boolean;
        pendingCompleted: boolean;
        commitReleased: boolean;
    };
    readonly releaseCommit: () => void;
}

async function createDeferredAdminCommitFixture(sql: PGliteSql): Promise<DeferredAdminCommitFixture> {
    const repository = createPSqlResourceInboxRepository(sql, () => new Date());
    const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
    const inbox = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
    const outbox = new OutboxQueueReader(queue);
    const now = await readPGliteDatabaseEpochMs(sql);
    const state = { wakeCount: 0, processingCompleted: false, pendingCompleted: false, commitReleased: false };
    const gate: DeferredAdminCommitGate = { written: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
    const appAdmin = createApiAdminInboxService({
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        inboxQueueReader: inbox,
        outboxQueueReader: outbox,
        wakeQueueEngine: () => {
            state.wakeCount += 1;
        },
        resourceInboxRepository: repository,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: createDeferredAdminCommitDatabase(sql, gate),
        serviceId: 'server-1',
        options: {
            waitMaxElapsedMsecs: 1_000,
            waitRetryIntervalMsecs: 0,
            waitMaxRetryIntervalMsecs: 0,
            waitJitterRatio: 0,
            nowEpochMs: Date.now
        },
        currentAuthority: {
            readSession: () => Promise.resolve({ clientId: 'admin', sessionId: 'admin-session', expiresAtEpochMs: now + 60_000 }),
            adminClientIds: ['admin']
        }
    });
    const pending = appAdmin.pruneExpired({
        adminSession: {
            clientId: 'admin',
            username: 'admin',
            sessionId: 'admin-session',
            accessToken: 'not-persisted',
            expiresAtEpochMs: now + 60_000
        },
        requestId: 'deferred-commit-prune',
        request: { categories: ['runtime-state'], dryRun: false }
    });
    pending.then(() => {
        state.pendingCompleted = true;
    }, () => {
        state.pendingCompleted = true;
    });
    return {
        sql,
        inbox,
        outbox,
        gate,
        pending,
        processing: undefined,
        state,
        releaseCommit: () => {
            state.commitReleased = true;
            gate.released.resolve();
        }
    };
}

function createDeferredAdminCommitDatabase(sql: PGliteSql, gate: DeferredAdminCommitGate): PSqlSql {
    return new Proxy(sql, {
        get: (target, property, receiver) => {
            if (property !== 'begin') {
                return Reflect.get(target, property, receiver);
            }
            const begin: PSqlSql['begin'] = async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
                await sql.begin(async (transaction) => {
                    const result = await write(transaction);
                    gate.written.resolve();
                    await gate.released.promise;
                    return result;
                });
            return begin;
        }
    });
}

/** Owns the held commit and every started operation before the enclosing database closes. */
async function assertDeferredAdminCommit(fixture: DeferredAdminCommitFixture, assertBeforeCommit: () => void): Promise<void> {
    let primaryFailure: Error | undefined;
    try {
        await waitForPGliteQueueRow(fixture.sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => fixture.state.wakeCount, 1);
        fixture.state.wakeCount = 0;
        fixture.processing = fixture.inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        fixture.processing.then(() => {
            fixture.state.processingCompleted = true;
        }, () => {
            fixture.state.processingCompleted = true;
        });
        await fixture.gate.written.promise;
        assertBeforeCommit();
        fixture.releaseCommit();
        await fixture.processing;
        assert.equal(fixture.state.wakeCount, 1);
        await waitForPGliteQueueRow(fixture.sql, 'APP_OUTBOX', 'NEW');
        await fixture.outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await fixture.pending;
    }
    catch (caught) {
        primaryFailure = toError(caught);
    }
    fixture.releaseCommit();
    const outcomes = await Promise.allSettled([fixture.processing, fixture.pending]);
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [toError(outcome.reason)] : []);
    if (primaryFailure) {
        if (failures.length > 0) {
            try {
                console.error('Deferred admin commit cleanup failed', new AggregateError(failures, 'Admin commit cleanup'));
            }
            catch {
                // Preserve the exact original assertion failure if reporting also fails.
            }
        }
        throw primaryFailure;
    }
    if (failures[0]) {
        throw failures[0];
    }
}

Deno.test('dry-run initial admin work does not wake after its transaction commits', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        const inbox = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const appAdmin = createApiAdminInboxService({
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            inboxQueueReader: inbox,
            outboxQueueReader: new OutboxQueueReader(queue),
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: sql,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1_000,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: Date.now
            },
            currentAuthority: {
                readSession: () =>
                    Promise.resolve({
                        clientId: 'admin',
                        sessionId: 'admin-session',
                        expiresAtEpochMs: now + 60_000
                    }),
                adminClientIds: ['admin']
            }
        });
        const pending = appAdmin.pruneExpired({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                sessionId: 'admin-session',
                accessToken: 'not-persisted',
                expiresAtEpochMs: now + 60_000
            },
            requestId: 'dry-run-prune',
            request: { categories: ['runtime-state'], dryRun: true }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => wakeCount, 1);
        wakeCount = 0;
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await pending;
        assert.equal(wakeCount, 0);
    });
});

Deno.test('rolled-back initial admin page work does not wake the queue', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        const inbox = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const failingDatabase = new Proxy(sql, {
            get: (target, property, receiver) => {
                if (property !== 'begin') {
                    return Reflect.get(target, property, receiver);
                }
                const begin: PSqlSql['begin'] = async <T>(
                    write: (transaction: PSqlSql) => Promise<T>
                ): Promise<T> =>
                    await sql.begin(async (transaction) => {
                        await write(transaction);
                        throw new Error('forced rollback after page insertion');
                    });
                return begin;
            }
        });
        const appAdmin = createApiAdminInboxService({
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            inboxQueueReader: inbox,
            outboxQueueReader: new OutboxQueueReader(queue),
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: failingDatabase,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: Date.now
            },
            currentAuthority: {
                readSession: () =>
                    Promise.resolve({
                        clientId: 'admin',
                        sessionId: 'admin-session',
                        expiresAtEpochMs: now + 60_000
                    }),
                adminClientIds: ['admin']
            }
        });
        const pending = appAdmin.pruneExpired({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                sessionId: 'admin-session',
                accessToken: 'not-persisted',
                expiresAtEpochMs: now + 60_000
            },
            requestId: 'rollback-prune',
            request: { categories: ['runtime-state'], dryRun: false }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => wakeCount, 1);
        wakeCount = 0;
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await pending;
        assert.equal(wakeCount, 0);
        const [page] = await sql<{ count: string; }[]>`
      select count(*) as count from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_topic_id = 'rallar.admin.prune-expired'
    `;
        assert.equal(Number(page?.count ?? 0), 0);
    });
});

Deno.test('rejected initial admin outbox write does not wake or persist page work', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        const inbox = new InboxQueueReader(queue, { newLaneConcurrency: 1 });
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const rejectingDatabase = new Proxy(sql, {
            get: (target, property, receiver) => {
                if (property !== 'begin') {
                    return Reflect.get(target, property, receiver);
                }
                const begin: PSqlSql['begin'] = async <T>(
                    write: (transaction: PSqlSql) => Promise<T>
                ): Promise<T> => await sql.begin(async (transaction) => await write(rejectInitialOutboxInsert(transaction)));
                return begin;
            }
        });
        const appAdmin = createApiAdminInboxService({
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            inboxQueueReader: inbox,
            outboxQueueReader: new OutboxQueueReader(queue),
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: rejectingDatabase,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: Date.now
            },
            currentAuthority: {
                readSession: () =>
                    Promise.resolve({
                        clientId: 'admin',
                        sessionId: 'admin-session',
                        expiresAtEpochMs: now + 60_000
                    }),
                adminClientIds: ['admin']
            }
        });
        const pending = appAdmin.pruneExpired({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                sessionId: 'admin-session',
                accessToken: 'not-persisted',
                expiresAtEpochMs: now + 60_000
            },
            requestId: 'write-rejected-prune',
            request: { categories: ['runtime-state'], dryRun: false }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => wakeCount, 1);
        wakeCount = 0;
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        await pending;
        assert.equal(wakeCount, 0);
        const [page] = await sql<{ count: string; }[]>`
      select count(*) as count from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_topic_id = 'rallar.admin.prune-expired'
    `;
        assert.equal(Number(page?.count ?? 0), 0);
    });
});

function rejectInitialOutboxInsert(transaction: PSqlSql): PSqlSql {
    return new Proxy(transaction, {
        apply: (target, thisArgument, argumentsList) => {
            const [strings] = argumentsList;
            if (
                Array.isArray(strings) &&
                strings.join('').includes('insert into resource_inbox')
            ) {
                throw new Error('rejected initial outbox write');
            }
            return Reflect.apply(target, thisArgument, argumentsList);
        }
    });
}

async function runRealEngineHandoffTest(sql: PGliteSql): Promise<void> {
    await assertUtcPGliteSession(sql);
    const fixture = await RealEngineAdminPruneFixture.create(sql);
    fixture.start();
    try {
        const result = await fixture.prune();
        const rows = await sql<Readonly<{ status: string; attempts: number; }>[]>`
      select ri_status as status, ri_attempts as attempts
      from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
        and ri_topic_id = 'rallar.admin.prune-expired'
    `;
        assert.equal(result.right?.status, 'completed');
        assert.deepEqual(rows, [{ status: 'COMPLETED', attempts: 1 }]);
        assert.equal(fixture.wakeCount, 3);
    }
    finally {
        await fixture.stop();
    }
}

async function waitForWakeCount(readCount: () => number, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (readCount() >= expected) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${expected} queue wake(s)`);
}
