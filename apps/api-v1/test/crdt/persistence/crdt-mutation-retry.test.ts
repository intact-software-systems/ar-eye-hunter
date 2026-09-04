import assert from 'node:assert/strict';

import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';

import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';

import { createApiCrdtInboxService } from '../../../src/crdt/create-api-crdt-inbox-service.ts';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { toResilienceDto } from '../../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from '../../db/pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from '../../db/pglite-auth-test-harness.ts';

import { queueNow, update, withCompetingWrite } from '../crdt-api-test-fixtures.ts';

interface RetryMutationCountsRow {
    readonly updates: string;
    readonly owner_updates: string;
    readonly owner_outbox: string;
}

interface ResourceInboxResultPayloadRow {
    readonly ris_resource: string;
}

interface RetryMutationScenario {
    readonly service: ReturnType<typeof createApiCrdtInboxService>;
    readonly inboxQueueReader: InboxQueueReader;
    readonly documentAuthorityReadCount: () => number;
}

Deno.test(
    'real SQL CAS conflict retries from revoked room membership and commits no owner effect',
    verifyRealSqlCasConflictRetry
);

async function verifyRealSqlCasConflictRetry(): Promise<void> {
    await withPGliteSql(async (sql) => {
        const now = await queueNow(sql);
        const scenario = createRetryMutationScenario(sql, now);
        await enqueueOwnerUpdate(scenario.service, now);
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await scenario.inboxQueueReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            toResilienceDto()
        );
        await assertRetryMutationOutcome(sql, scenario.documentAuthorityReadCount());
    });
}

function createRetryMutationScenario(sql: PGliteSql, now: number): RetryMutationScenario {
    let membershipAllowed = true;
    let documentAuthorityReads = 0;
    const database = withCompetingWrite(sql, now, () => {
        membershipAllowed = false;
    });
    const resourceInbox = createPSqlResourceInboxRepository(sql);
    const inboxQueueReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    return {
        service: createApiCrdtInboxService({
            inboxQueueReader,
            resourceInboxRepository: resourceInbox.entries,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database,
            serviceId: 'server-1',
            timing: undefined,
            options: { nowEpochMs: () => now },
            wakeQueueEngine: () => undefined,
            currentAuthority: {
                readSession: (sessionId: string) =>
                    Promise.resolve({
                        clientId: 'client-1',
                        username: 'principal-1',
                        sessionId,
                        expiresAtEpochMs: now + 60_000
                    }),
                adminClientIds: ['admin'],
                authorizeDocument: () => {
                    documentAuthorityReads += 1;
                    return Promise.resolve({
                        allowed: membershipAllowed,
                        code: membershipAllowed ? 'allowed' : 'authorization-scope-denied'
                    });
                }
            },
            policies: [{ documentType: 'checklist', rollout: 'production' }]
        }),
        inboxQueueReader,
        documentAuthorityReadCount: () => documentAuthorityReads
    };
}

async function enqueueOwnerUpdate(
    service: ReturnType<typeof createApiCrdtInboxService>,
    now: number
): Promise<void> {
    await service.createAndEnqueueAppend({
        update: update('owner-update', now - 1_000),
        deliveryId: 'owner-delivery',
        actor: {
            actorId: 'client-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            serverId: 'server-1'
        },
        responseAudience: {
            kind: 'room',
            senderSessionId: 'session-1',
            topicId: 'room.crdt',
            contextId: 'group-1'
        },
        capturedAtEpochMs: now,
        expireAtEpochMs: now + 60_000
    });
}

async function assertRetryMutationOutcome(
    sql: PGliteSql,
    documentAuthorityReads: number
): Promise<void> {
    const [counts] = await sql<RetryMutationCountsRow[]>`
      select
          (select count(*) from crdt_updates)::text as updates,
          (select count(*) from crdt_updates where update_id = 'owner-update')::text
              as owner_updates,
          (select count(*) from resource_inbox
           where ri_type_id = 'WS_OUTBOX'
             and ri_resource_id in ('crdt:owner-delivery:reply', 'crdt:owner-update:fanout'))::text
              as owner_outbox
  `;
    assert.deepEqual(counts, { updates: '1', owner_updates: '0', owner_outbox: '0' });
    assert.equal(documentAuthorityReads, 2);
    const [completion] = await sql<ResourceInboxResultPayloadRow[]>`
      select ris_resource from resource_inbox_results
      where ris_topic_id = 'app-inbox.crdt-state'
        and ris_resource_id = 'owner-delivery'
  `;
    assert.ok(completion);
    const result = decodeCrdtMutationResult(JSON.parse(completion.ris_resource));
    assert.equal(result.code, 'authorization-scope-denied');
}
