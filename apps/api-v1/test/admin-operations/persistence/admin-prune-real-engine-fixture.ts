import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxRepository } from '@shared-server/queuebox/postgres/resource-inbox-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import {
    includeInboxQueueReaderEngineTasks,
    includeOutboxQueueReaderEngineTasks
} from '@shared-server/rallar-system/middleware/rallar-middleware.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import assert from 'node:assert/strict';
import { createApiAdminInboxService } from '../../../src/admin-operations/create-api-admin-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { readPGliteDatabaseEpochMs } from '../../db/pglite-auth-test-harness.ts';

type ApiAdminInboxService = ReturnType<typeof createApiAdminInboxService>;
type AdminPruneResult = Awaited<ReturnType<ApiAdminInboxService['pruneExpired']>>;

export async function assertUtcPGliteSession(sql: PGliteSql): Promise<void> {
    const [databaseSession] = await sql<{ isUtc: boolean; }[]>`
    select (now() at time zone 'UTC') = now()::timestamp as "isUtc"
  `;
    assert.equal(
        databaseSession?.isUtc,
        true,
        'The real-engine PGlite fixture must run with an explicit UTC session'
    );
}

export class RealEngineAdminPruneFixture {
    readonly engine = new InboxOutboxEngine();
    readonly activeDequeues = new Set<Promise<void>>();
    readonly appAdmin: ReturnType<typeof createApiAdminInboxService>;
    wakeCount = 0;

    private readonly now: number;

    private constructor(sql: PGliteSql, now: number) {
        this.now = now;
        const repository = new ResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const inbox = new InboxQueueReader(queue);
        const outbox = new OutboxQueueReader(queue);
        inbox.dequeueInbox = trackDequeue(this.activeDequeues, inbox.dequeueInbox.bind(inbox));
        outbox.dequeueOutbox = trackDequeue(this.activeDequeues, outbox.dequeueOutbox.bind(outbox));
        includeInboxQueueReaderEngineTasks(this.engine, inbox, toResilienceDto());
        includeOutboxQueueReaderEngineTasks(this.engine, outbox, toResilienceDto());
        this.appAdmin = createApiAdminInboxService({
            inboxQueueReader: inbox,
            outboxQueueReader: outbox,
            wakeQueueEngine: () => this.wake(),
            resourceInboxRepository: repository,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database: sql,
            serviceId: 'server-1',
            options: { waitMaxElapsedMsecs: 10_000, nowEpochMs: () => this.now },
            currentAuthority: {
                readSession: () => Promise.resolve(this.adminAuthority()),
                adminClientIds: ['admin']
            }
        });
    }

    static async create(sql: PGliteSql): Promise<RealEngineAdminPruneFixture> {
        return new RealEngineAdminPruneFixture(sql, await readPGliteDatabaseEpochMs(sql));
    }

    start(): void {
        this.engine.start();
    }

    async prune(): Promise<AdminPruneResult> {
        return await this.appAdmin.pruneExpired({
            adminSession: {
                clientId: 'admin',
                username: 'admin',
                sessionId: 'admin-session',
                accessToken: 'not-persisted',
                expiresAtEpochMs: this.now + 60_000
            },
            requestId: 'queue-engine-handoff-prune',
            request: {
                categories: ['runtime-state'],
                dryRun: false
            }
        });
    }

    async stopAndDrain(): Promise<void> {
        this.engine.stop();
        while (this.activeDequeues.size > 0) {
            await Promise.allSettled([...this.activeDequeues]);
        }
        assert.equal(this.activeDequeues.size, 0);
    }

    private wake(): void {
        this.wakeCount += 1;
        this.engine.wake();
    }

    private adminAuthority(): {
        clientId: string;
        sessionId: string;
        expiresAtEpochMs: number;
    } {
        return {
            clientId: 'admin',
            sessionId: 'admin-session',
            expiresAtEpochMs: this.now + 60_000
        };
    }
}

function trackDequeue<Args extends unknown[]>(
    active: Set<Promise<void>>,
    dequeue: (...args: Args) => Promise<void>
): (...args: Args) => Promise<void> {
    return (...args) => {
        const pending = dequeue(...args);
        active.add(pending);
        void pending.then(
            () => active.delete(pending),
            () => active.delete(pending)
        );
        return pending;
    };
}
