import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type {
    ResourceInboxResultsRepository
} from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type {
    RallarCrdtInboxServiceFactory
} from '@shared-server/rallar-system/middleware/rallar-middleware-options.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';

import { createApiCrdtInboxService, type CurrentMutationAuthority } from './create-api-crdt-inbox-service.ts';

export interface CreateApiCrdtInboxFactoryInput {
    readonly resourceInboxRepository: PSqlResourceInboxEntryRepository;
    readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly timing: RallarTimingSink | undefined;
    readonly options: AppInboxOptions;
    readonly currentAuthority: CurrentMutationAuthority;
    readonly policies: readonly RallarCrdtDocumentTypePolicy[];
}

export function createApiCrdtInboxFactory(
    input: CreateApiCrdtInboxFactoryInput
): RallarCrdtInboxServiceFactory {
    return ({ inboxQueueReader, wakeQueueEngine }) =>
        createApiCrdtInboxService({
            inboxQueueReader,
            resourceInboxRepository: input.resourceInboxRepository,
            resourceInboxResultsRepository: input.resourceInboxResultsRepository,
            database: input.database,
            serviceId: input.serviceId,
            timing: input.timing,
            options: input.options,
            currentAuthority: input.currentAuthority,
            policies: input.policies,
            wakeQueueEngine
        });
}
