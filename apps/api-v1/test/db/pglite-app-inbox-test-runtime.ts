import assert from 'node:assert/strict';

import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { AppInboxQueueClient, AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { EntityStatus, toResourceEntryWithUpdatedResource } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';

interface EpochMillisecondsRow {
    readonly epoch_ms: string | number;
}

interface StringCountRow {
    readonly count: string;
}

export async function readPGliteDatabaseEpochMs(sql: PGliteSql): Promise<number> {
    const [clock] = await sql<EpochMillisecondsRow[]>`
    select floor(extract(epoch from now()) * 1000)::bigint as epoch_ms
  `;
    assert.ok(clock);
    return Number(clock.epoch_ms);
}

export async function readPGliteAppInboxFailure(
    sql: PGliteSql,
    resourceId: string,
    resource: JsonWireValue
) {
    const inbox = new ResourceInboxRepository(sql);
    const results = new ResourceInboxResultsRepository(sql);
    const service = new AppInboxQueueClient(
        {
            inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(inbox)),
            resourceInboxRepository: inbox,
            resourceInboxResultsRepository: results
        },
        {
            serviceId: 'pglite-failure-reader',
            options: {
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 2,
                waitJitterRatio: 0
            }
        }
    );
    const enqueue = {
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        resourceId,
        contextId: 'failure-context',
        data: { requestId: resourceId }
    } as const;
    const typedPending = service.processEntryUntilCompletionResult(enqueue, (value) => value);
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    const key = {
        topicId: 'app-inbox.group-state',
        resourceId,
        contextId: enqueue.contextId
    };
    const entry = await inbox.findByKey(key);
    assert.ok(entry);
    const reserved = await inbox.startProcessingEntity(entry);
    assert.ok(reserved.right);
    await results.replace(
        toResourceEntryWithUpdatedResource(
            reserved.right,
            EntityStatus.FAILED,
            resource
        )
    );
    assert.ok(
        await inbox.finishReserved(
            key,
            reserved.right.dequeueAudit.attempts,
            EntityStatus.FAILED,
            new Date()
        )
    );
    return await typedPending;
}

export async function waitForPGliteQueueRow(
    sql: PGliteSql,
    typeId: string,
    status: string
): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await sql<StringCountRow[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = ${typeId} and ri_status = ${status}
    `;
        if (Number(row?.count ?? 0) > 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`Timed out waiting for ${typeId} ${status} queue row`);
}
