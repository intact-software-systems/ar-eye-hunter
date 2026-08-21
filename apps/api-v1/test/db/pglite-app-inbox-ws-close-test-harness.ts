import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
    createClientStateEventRepository,
    createGroupStateEventRepository
} from '@shared-server/postgres/rallar-system/createStateRepositories.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    createClientStateService,
    type ClientStateService
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    createGroupStateService,
    type GroupStateService
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { FUTURE_MS } from './pglite-auth-test-harness.ts';

export async function createPGliteAppInboxWsCloseHarness(sql: PGliteSql) {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    const resourceResults = new ResourceInboxResultsRepository(sql);
    const reader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const secondReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const authority = {
        clientId: 'owner',
        username: 'owner',
        sessionId: 'owner-session',
        accessToken: 'owner-token',
        issuedAtEpochMs: Date.now() - 2_000,
        expiresAtEpochMs: FUTURE_MS
    };
    const authSessions = new AuthSessionRepository(runtime);
    await authSessions.putSession(authority);
    const options = {
        waitMaxElapsedMsecs: 5_000,
        waitRetryIntervalMsecs: 1,
        waitMaxRetryIntervalMsecs: 4,
        waitJitterRatio: 0
    } as const;
    const groupEvents = createGroupStateEventRepository(runtime);
    const clientState = createClientStateService({
        runtimeRepository: runtime,
        formationDamping: 'damped',
        createClientStateEventStore: createClientStateEventRepository,
        serviceId: 'pglite-close-test'
    });
    const groupState = createGroupStateService({
        runtimeRepository: runtime,
        formationDamping: 'damped',
        createGroupStateEventStore: createGroupStateEventRepository,
        authSessionRepository: authSessions,
        serviceId: 'pglite-close-test'
    });
    const client = new AppClientInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceResults,
            database: sql,
            clientStateService: clientState
        },
        {
            serviceId: 'pglite-close-test',
            timing: undefined,
            options: options
        }
    );
    const group = new AppGroupInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceResults,
            database: sql,
            groupStateService: groupState
        },
        {
            serviceId: 'pglite-close-test',
            timing: undefined,
            options: options
        }
    );
    new AppClientInboxService(
        {
            inboxQueueReader: secondReader,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceResults,
            database: sql,
            clientStateService: clientState
        },
        {
            serviceId: 'pglite-close-test',
            timing: undefined,
            options: options
        }
    );
    new AppGroupInboxService(
        {
            inboxQueueReader: secondReader,
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: resourceResults,
            database: sql,
            groupStateService: groupState
        },
        {
            serviceId: 'pglite-close-test',
            timing: undefined,
            options: options
        }
    );
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
        clients: new ClientStateRepository(runtime, {
            events: createClientStateEventRepository(runtime)
        }),
        groups: new GroupStateRepository(runtime, { events: groupEvents })
    };
}

export function pauseNextPGliteLifecycleRead(
    state: Pick<ClientStateService | GroupStateService, 'sessionGenerationLifecycle'>
): Readonly<{ reached: Promise<void>; resume(): void; }> {
    const lifecycle = state.sessionGenerationLifecycle;
    const originalRead = lifecycle.read.bind(lifecycle);
    let release!: () => void;
    let announce!: () => void;
    const reached = new Promise<void>((resolve) => announce = resolve);
    const resumed = new Promise<void>((resolve) => release = resolve);
    let pause = true;
    lifecycle.read = async (identity) => {
        const read = await originalRead(identity);
        if (pause) {
            pause = false;
            announce();
            await resumed;
        }
        return read;
    };
    return { reached, resume: release };
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
