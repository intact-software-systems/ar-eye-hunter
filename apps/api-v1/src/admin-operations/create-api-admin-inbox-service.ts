import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { resourceInboxRetryExpiryAtEpochMs } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import { PSqlAdminOperationsPruner } from '@shared-server/postgres/admin-operations/\
p-sql-admin-operations-pruner.ts';
import { PSqlAdminPruneRepository } from '@shared-server/postgres/admin-operations/\
p-sql-admin-prune-repository.ts';

import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxRepository.ts';

import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
import {
    AppAdminInboxService,
    createAdminPruneIdempotencyIdentity
} from '@shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts';
import { AdminPrunePageWorker } from '@shared-server/rallar-system/admin-operations/prune/\
admin-prune-page-worker.ts';

import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/\
AppInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';

export interface ApiAdminPruneCurrentAuthority {
    readSession(sessionId: string): Promise<
        | Readonly<{
            clientId: string;
            sessionId: string;
            expiresAtEpochMs: number;
        }>
        | null
        | undefined
    >;
    adminClientIds: readonly string[];
}

export interface CreateApiAdminInboxServiceInput {
    inboxQueueReader: InboxQueueReader;
    outboxQueueReader: OutboxQueueReader;
    wakeQueueEngine: () => void;
    resourceInboxRepository: ResourceInboxRepository;
    resourceInboxResultsRepository: ResourceInboxResultsRepository;
    database: PSqlSql;
    serviceId: string;
    timing?: RallarTimingSink;
    options?: AppInboxServiceOptions;
    currentAuthority: ApiAdminPruneCurrentAuthority;
}

export function createApiAdminInboxService(
    input: Readonly<CreateApiAdminInboxServiceInput>
): AppAdminInboxService {
    const pageSize = 100;
    const readAuthority = async (
        authority: Readonly<{
            requestedBy: string;
            requestedSessionId: string;
            nowEpochMs: number;
        }>
    ) => {
        const session = await input.currentAuthority.readSession(
            authority.requestedSessionId
        );
        const allowed = Boolean(
            session &&
                session.clientId === authority.requestedBy &&
                session.sessionId === authority.requestedSessionId &&
                session.expiresAtEpochMs > authority.nowEpochMs &&
                input.currentAuthority.adminClientIds.includes(session.clientId)
        );
        return {
            allowed,
            code: allowed ? 'allowed' : 'admin-prune-authority-denied'
        };
    };
    const pageWork = new AdminPrunePageWorker({
        database: input.database,
        repository: new PSqlAdminPruneRepository(input.database),
        serviceId: input.serviceId,
        pageSize,
        now: input.options?.nowEpochMs,
        readAuthority,
        wakeQueue: input.wakeQueueEngine
    });
    input.outboxQueueReader.onOutboxMessageDo(AppInboxType.ADMIN_PRUNE_EXPIRED, {
        onMessage: async (_message, entry) => await pageWork.processReservedEntry(entry)
    });
    return new AppAdminInboxService(
        {
            inboxQueueReader: input.inboxQueueReader,
            resourceInboxRepository: input.resourceInboxRepository,
            resourceInboxResultsRepository: input.resourceInboxResultsRepository,
            database: input.database,
            pruner: new PSqlAdminOperationsPruner(input.database),
            readAuthority,
            wakeQueueEngine: input.wakeQueueEngine,
            computeRetryExpiryAtEpochMs: resourceInboxRetryExpiryAtEpochMs,
            createAdminPruneIdempotencyIdentity
        },
        {
            serviceId: input.serviceId,
            pageSize,
            timing: input.timing,
            appInbox: input.options ?? {}
        }
    );
}
