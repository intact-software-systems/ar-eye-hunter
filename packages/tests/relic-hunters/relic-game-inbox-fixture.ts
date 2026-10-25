import { Temporal } from '@js-temporal/polyfill';

import { RelicGameInboxService } from '@relic-hunters/server/relic-game-inbox-service.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createGameFixture } from './relic-game-database-fixture.ts';

interface RelicInboxFixtureOptions {
    readonly gameId?: string;
    readonly timing?: RallarTimingSink;
}

export async function createInboxFixture(options: RelicInboxFixtureOptions = {}) {
    const fixture = await createGameFixture(options.gameId);
    const resources = createPSqlResourceInboxRepository(fixture.storage.sql, () => new Date(fixture.nowEpochMs));
    const queue = new PSqlQueueBox(resources, () => Temporal.Instant.fromEpochMilliseconds(fixture.nowEpochMs));
    const reader = new InboxQueueReader(queue, {
        newLaneConcurrency: 1,
        nowEpochMs: () => fixture.nowEpochMs,
        onRetryExhausted: createAppInboxRetryFinalizer({
            database: fixture.storage.sql,
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS
        })
    });
    const results = new ResourceInboxResultsRepository(fixture.storage.sql);
    const inbox = new RelicGameInboxService({
        service: fixture.service,
        inboxQueueReader: reader,
        resourceInboxRepository: resources.entries,
        resourceInboxResultsRepository: results,
        database: fixture.storage.sql,
        wakeQueue: () => undefined
    }, {
        serviceId: 'relic-inbox-test',
        serverPeerId: 'default-qbox-server',
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        timing: options.timing,
        options: { nowEpochMs: () => fixture.nowEpochMs }
    });
    return Object.assign(fixture, { inbox, reader, results, resources });
}
