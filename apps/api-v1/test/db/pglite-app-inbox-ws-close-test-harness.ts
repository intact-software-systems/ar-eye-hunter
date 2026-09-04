import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { type ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { type GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { FUTURE_MS } from './pglite-auth-test-harness.ts';

export async function createPGliteAppInboxWsCloseHarness(sql: PGliteSql): Promise<PGliteAppInboxWsCloseHarness> {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = createPSqlResourceInboxRepository(sql);
    const resourceResults = new ResourceInboxResultsRepository(sql);
    const reader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const secondReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
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
        readPlannedLayoutRow: () => Promise.resolve(null),
        readAcceptedLayoutRow: () => Promise.resolve(null),
        runtimeRepository: runtime,
        groupStateEventStore: groupEvents,
        authSessionRepository: authSessions,
        serviceId: 'pglite-close-test'
    });
    const groups = new GroupStateRepository(runtime, groupEvents);
    const consumers = { sql, resourceInbox, resourceResults, clientState, groupState, groups, options };
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
        groups
    };
}

export function pauseNextPGliteLifecycleRead(
    state: Pick<ClientStateService | GroupStateService, 'sessionGenerationLifecycle'>
): Readonly<{ reached: Promise<void>; resume(): void; }> {
    const lifecycle = state.sessionGenerationLifecycle;
    const originalRead = lifecycle.read.bind(lifecycle);
    const reached = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let pause = true;
    lifecycle.read = async (identity) => {
        const read = await originalRead(identity);
        if (pause) {
            pause = false;
            reached.resolve();
            await resumed.promise;
        }
        return read;
    };
    return { reached: reached.promise, resume: resumed.resolve };
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

export async function assertPGliteQueueRetriedAndCompleted(
    sql: PGliteSql,
    key: Readonly<{ topicId: string; resourceId: string; contextId: string; }>
): Promise<void> {
    const [row] = await sql<{ status: string; attempts: number; }[]>`
    select ri_status as status, ri_attempts as attempts from resource_inbox
    where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId}
      and fk_ext_bank_id = ${key.contextId}
  `;
    if (row?.status !== 'COMPLETED' || Number(row.attempts) < 2) {
        throw new Error('Expected AppInbox to complete after a full retry');
    }
}

function assertPGliteQueueRow(found: boolean, type: AppInboxType): void {
    if (!found) {
        throw new Error(`Expected a real ${type} queue row`);
    }
}

interface PGliteAppInboxWsCloseHarness {
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
}
interface PGliteStateInboxConsumerInput {
    readonly sql: PGliteSql;
    readonly reader: InboxQueueReader;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceResults: ResourceInboxResultsRepository;
    readonly clientState: ClientStateService;
    readonly groupState: GroupStateService;
    readonly groups: GroupStateRepository;
    readonly options: {
        readonly waitMaxElapsedMsecs: number;
        readonly waitRetryIntervalMsecs: number;
        readonly waitMaxRetryIntervalMsecs: number;
        readonly waitJitterRatio: number;
    };
}
interface PGliteStateInboxConsumers {
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
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
            serviceId: 'pglite-close-test',
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
