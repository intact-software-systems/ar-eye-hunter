import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { type ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { ToAuthorisedWsClientConnectionInput } from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { type GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { putAuthorisedWsTestTicket } from '../../../../packages/tests/shared-server/rallar-system/client-state/authorised-ws-test-ticket.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/client-state/test-disconnected-session-retention.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteFirstRetryEligibility } from './pglite-app-inbox-test-runtime.ts';
import { FUTURE_MS } from './pglite-auth-test-harness.ts';

export interface PGliteAppInboxWsCloseHarness {
    readonly authority: IssuedAuthSession;
    readonly runtime: PSqlRuntimeStateRepository;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly reader: InboxQueueReader;
    readonly secondReader: InboxQueueReader;
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
    readonly clientState: ClientStateService;
    readonly groupState: GroupStateService;
    readonly clients: ClientStateRepository;
    readonly groups: GroupStateRepository;
    /** Starts an upgrade's connect with a fresh ticket; it waits for its result while the test drives the queue. */
    startAuthorisedWsConnect(input: ToAuthorisedWsClientConnectionInput): Promise<ResourceEntry>;
}
interface PGliteStateInboxConsumerInput {
    readonly sql: PGliteSql;
    readonly reader: InboxQueueReader;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceResults: ResourceInboxResultsRepository;
    readonly clientState: ClientStateService;
    readonly groupState: GroupStateService;
    readonly groups: GroupStateRepository;
    readonly options: AppInboxOptions;
    readonly authSessions: AuthSessionRepository;
}
interface PGliteStateInboxConsumers {
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
}
export async function createPGliteAppInboxWsCloseHarness(sql: PGliteSql): Promise<PGliteAppInboxWsCloseHarness> {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const resourceResults = new ResourceInboxResultsRepository(sql);
    const reader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        newLaneConcurrency: 1
    });
    const secondReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        newLaneConcurrency: 1
    });
    const authSessions = new AuthSessionRepository(runtime);
    const authority = await createPGliteCloseOwnerSession(authSessions);
    const options = {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0
    } as const;
    const groupEvents = new PSqlGroupStateEventRepository(runtime.sql);
    const clientState = createClientStateService({
        runtimeRepository: runtime,
        clientStateEventStore: new PSqlClientStateEventRepository(sql),
        serviceId: 'pglite-close-test'
    });
    const groupState = createGroupStateService({
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        readPlannedLayoutRow: () => Promise.resolve(null),
        readAcceptedLayoutRow: () => Promise.resolve(null),
        runtimeRepository: runtime,
        groupStateEventStore: groupEvents,
        serviceId: 'pglite-close-test'
    });
    const groups = new GroupStateRepository(runtime, groupEvents);
    const consumers = { sql, resourceInbox, resourceResults, clientState, groupState, groups, options, authSessions };
    const { client, group } = createPGliteStateInboxConsumers({ ...consumers, reader });
    createPGliteStateInboxConsumers({ ...consumers, reader: secondReader });
    return {
        authority,
        runtime,
        resourceInbox,
        reader,
        secondReader,
        client,
        group,
        clientState,
        groupState,
        clients: new ClientStateRepository(runtime, new PSqlClientStateEventRepository(sql)),
        groups,
        startAuthorisedWsConnect: async (input) => {
            const ticketDigest = await putAuthorisedWsTestTicket(
                authSessions,
                input.authSession,
                `${input.generationId}-ticket`
            );
            const queued = await readPGliteQueuedKeys(sql);
            void client.writeAuthorisedWsClientConnect({
                ...input,
                ticketDigest,
                traceId: 'trace-pglite-app-inbox-ws-close-harness'
            });
            return await waitForNewPGliteQueueEntry(reader, sql, queued);
        }
    };
}

async function readPGliteQueuedKeys(sql: PGliteSql): Promise<ReadonlySet<string>> {
    const rows = await sql<{ id: string; }[]>`
      select ri_topic_id || '|' || ri_resource_id || '|' || fk_ext_bank_id as id from resource_inbox
    `;
    return new Set(rows.map((row) => row.id));
}

async function waitForNewPGliteQueueEntry(
    reader: InboxQueueReader,
    sql: PGliteSql,
    queued: ReadonlySet<string>
): Promise<ResourceEntry> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await sql<{ topic: string; resource: string; context: string; }[]>`
          select ri_topic_id as topic, ri_resource_id as resource, fk_ext_bank_id as context from resource_inbox
          where ri_type_id = 'APP_INBOX'
        `;
        const row = rows.find((candidate) =>
            !queued.has(`${candidate.topic}|${candidate.resource}|${candidate.context}`)
        );
        const entry = row === undefined
            ? undefined
            : await reader.inbox.getItem({ topicId: row.topic, resourceId: row.resource, contextId: row.context });
        if (entry !== undefined) {
            return entry;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The authorised connect was not queued');
}

export async function assertPGliteQueuedTypes(
    sql: PGliteSql,
    types: readonly AppInboxType[]
): Promise<void> {
    for (const type of types) {
        const [row] = await sql<{ count: string; }[]>`
      select count(*) as count from resource_inbox
      where ri_type_id = 'APP_INBOX' and ri_resource like ${`%${type}%`}
    `;
        assertPGliteQueueRow(Number(row?.count ?? 0) >= 1, type);
    }
}

export async function completePGliteAppInboxRetry(
    sql: PGliteSql,
    reader: InboxQueueReader,
    key: Key
): Promise<void> {
    const results = new ResourceInboxResultsRepository(sql);
    const afterFirst = await reader.inbox.getItem(key);
    assert.ok(afterFirst);
    if (afterFirst.status === EntityStatus.RETRY) {
        assert.equal(afterFirst.dequeueAudit.attempts, 1);
        assert.ok(afterFirst.dequeueAudit.nextTs);
        assert.equal(await results.findAnyByKey(key), null);
        await waitForPGliteFirstRetryEligibility(sql, key);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
    }
    else {
        assert.equal(afterFirst.status, EntityStatus.COMPLETED);
    }
    const completed = await reader.inbox.getItem(key);
    assert.ok(completed);
    assert.equal(completed.status, EntityStatus.COMPLETED);
    assert.equal(completed.dequeueAudit.attempts, 2);
    assert.equal((await results.findAnyByKey(key))?.status, EntityStatus.COMPLETED);
}

function assertPGliteQueueRow(found: boolean, type: AppInboxType): void {
    if (!found) {
        throw new Error(`Expected a real ${type} queue row`);
    }
}

function createPGliteStateInboxConsumers(input: PGliteStateInboxConsumerInput): PGliteStateInboxConsumers {
    const client = new AppClientInboxService(
        {
            inboxQueueReader: input.reader,
            resourceInboxRepository: input.resourceInbox.entries,
            resourceInboxResultsRepository: input.resourceResults,
            database: input.sql,
            clientStateService: input.clientState
        },
        {
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            serviceId: 'pglite-close-test',
            disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS,
            timing: undefined,
            options: input.options
        }
    );
    const group = new GroupStateInboxService(
        {
            inboxQueueReader: input.reader,
            resourceInboxRepository: input.resourceInbox.entries,
            resourceInboxResultsRepository: input.resourceResults,
            database: input.sql,
            groupStateService: input.groupState,
            resultReader: input.groups
        },
        {
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            serviceId: 'pglite-close-test',
            timing: undefined,
            options: input.options
        }
    );
    return { client, group };
}
async function createPGliteCloseOwnerSession(authSessions: AuthSessionRepository): Promise<IssuedAuthSession> {
    const authority = {
        clientId: 'owner',
        username: 'owner',
        sessionId: 'owner-session',
        accessToken: 'owner-token',
        issuedAtEpochMs: Date.now() - 2_000,
        expiresAtEpochMs: FUTURE_MS
    };
    await authSessions.putSession(authority);
    return authority;
}
