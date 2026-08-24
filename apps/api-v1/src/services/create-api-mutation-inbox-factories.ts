import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import type {
    ResourceInboxResultsRepository
} from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type {
    RallarAdminInboxServiceFactory,
    RallarCrdtInboxServiceFactory
} from '@shared-server/rallar-system/middleware/rallar-middleware-options.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';

import { createApiAdminInboxService } from '../admin-operations/create-api-admin-inbox-service.ts';

export interface CurrentAdminMutationSession {
    readonly clientId: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export interface CurrentAdminMutationAuthority {
    readSession(
        sessionId: string
    ): Promise<CurrentAdminMutationSession | null | undefined>;
    readonly adminClientIds: readonly string[];
}

export interface CreateApiMutationInboxFactoriesInput {
    readonly createAppCrdtInboxService: RallarCrdtInboxServiceFactory;
    readonly resourceInboxRepository: PSqlResourceInboxRepository;
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly timing: RallarTimingSink | undefined;
    readonly options: AppInboxOptions;
    readonly currentAuthority: CurrentAdminMutationAuthority;
}

export interface ApiMutationInboxFactories {
    readonly createAppCrdtInboxService: RallarCrdtInboxServiceFactory;
    readonly createAppAdminInboxService: RallarAdminInboxServiceFactory;
}

export function createApiMutationInboxFactories(
    input: CreateApiMutationInboxFactoriesInput
): ApiMutationInboxFactories {
    return {
        createAppCrdtInboxService: input.createAppCrdtInboxService,
        createAppAdminInboxService: ({
            inboxQueueReader,
            outboxQueueReader,
            wakeQueueEngine
        }) =>
            createApiAdminInboxService({
                inboxQueueReader,
                outboxQueueReader,
                wakeQueueEngine,
                resourceInboxRepository: input.resourceInboxRepository,
                resourceInboxResultsRepository: input.resourceInboxResultsRepository,
                database: input.database,
                serviceId: input.serviceId,
                timing: input.timing,
                options: input.options,
                currentAuthority: input.currentAuthority
            })
    };
}
