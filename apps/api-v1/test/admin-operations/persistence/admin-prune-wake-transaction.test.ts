import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { createPSqlResourceInboxRepository, type PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import assert from 'node:assert/strict';
import { createApiAdminInboxService } from '../../../src/admin-operations/create-api-admin-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { readPGliteDatabaseEpochMs, waitForPGliteQueueRow, withUtcPGliteSql } from '../../db/pglite-auth-test-harness.ts';
import { assertUtcPGliteSession, RealEngineAdminPruneFixture } from './admin-prune-real-engine-fixture.ts';

Deno.test('committed initial admin page work wakes the running queue engine into APP_OUTBOX processing', async () => {
    await withUtcPGliteSql(runRealEngineHandoffTest);
});

Deno.test('initial admin page work does not wake until its successful transaction commits', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        let releaseCommit: (() => void) | undefined;
        let observeWrite: (() => void) | undefined;
        const writeObserved = new Promise<void>((resolve) => {
            observeWrite = resolve;
        });
        const commitReleased = new Promise<void>((resolve) => {
            releaseCommit = resolve;
        });
        const deferredDatabase = Object.assign(
            (...args: unknown[]) => (sql as unknown as (...values: unknown[]) => unknown)(...args),
            sql,
            {
                begin: async <T>(write: (transaction: typeof sql) => Promise<T>): Promise<T> =>
                    await sql.begin(async (transaction) => {
                        const result = await write(transaction as typeof sql);
                        observeWrite?.();
                        await commitReleased;
                        return result;
                    })
            }
        );
        const appAdmin = createApiAdminInboxService({
            inboxQueueReader: inbox,
            outboxQueueReader: outbox,
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: deferredDatabase as never,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1_000,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: () => now
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
            requestId: 'deferred-commit-prune',
            request: { categories: ['runtime-state'], dryRun: false }
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await waitForWakeCount(() => wakeCount, 1);
        wakeCount = 0;
        const processing = inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
        await writeObserved;
        assert.equal(wakeCount, 0);
        releaseCommit?.();
        await processing;
        assert.equal(wakeCount, 1);
        await waitForPGliteQueueRow(sql, 'APP_OUTBOX', 'NEW');
        await outbox.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, toResilienceDto());
        await pending;
    });
});

Deno.test('dry-run initial admin work does not wake after its transaction commits', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const appAdmin = createApiAdminInboxService({
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
                nowEpochMs: () => now
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
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
        await pending;
        assert.equal(wakeCount, 0);
    });
});

Deno.test('rolled-back initial admin page work does not wake the queue', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const failingDatabase = Object.assign(
            (...args: unknown[]) => (sql as unknown as (...values: unknown[]) => unknown)(...args),
            sql,
            {
                begin: async <T>(write: (transaction: typeof sql) => Promise<T>): Promise<T> =>
                    await sql.begin(async (transaction) => {
                        await write(transaction as typeof sql);
                        throw new Error('forced rollback after page insertion');
                    })
            }
        );
        const appAdmin = createApiAdminInboxService({
            inboxQueueReader: inbox,
            outboxQueueReader: new OutboxQueueReader(queue),
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: failingDatabase as never,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: () => now
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
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
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
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const now = await readPGliteDatabaseEpochMs(sql);
        let wakeCount = 0;
        const rejectingDatabase = Object.assign(
            (...args: unknown[]) => (sql as unknown as (...values: unknown[]) => unknown)(...args),
            sql,
            {
                begin: async <T>(write: (transaction: typeof sql) => Promise<T>): Promise<T> =>
                    await sql.begin(async (transaction) => {
                        const rejectingTransaction = Object.assign(
                            (...args: unknown[]) => {
                                const [strings] = args;
                                if (
                                    Array.isArray(strings) && strings.join('').includes('insert into resource_inbox')
                                ) {
                                    throw new Error('rejected initial outbox write');
                                }
                                return (transaction as unknown as (...values: unknown[]) => unknown)(...args);
                            },
                            transaction
                        ) as typeof sql;
                        return await write(rejectingTransaction);
                    })
            }
        );
        const appAdmin = createApiAdminInboxService({
            inboxQueueReader: inbox,
            outboxQueueReader: new OutboxQueueReader(queue),
            wakeQueueEngine: () => {
                wakeCount += 1;
            },
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: rejectingDatabase as never,
            serviceId: 'server-1',
            options: {
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 0,
                waitMaxRetryIntervalMsecs: 0,
                waitJitterRatio: 0,
                nowEpochMs: () => now
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
        await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, toResilienceDto());
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
        await fixture.stopAndDrain();
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
