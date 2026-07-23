import type {
  RallarAdminInboxServiceFactory,
  RallarCrdtInboxServiceFactory,
} from '@shared-server/rallar-system/middleware/rallar-middleware-options.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import { createApiAdminInboxService } from './create-api-admin-inbox-service.ts';
import { createApiCrdtInboxService } from './create-api-crdt-inbox-service.ts';

type CurrentMutationAuthority = Readonly<{
  readSession(sessionId: string): Promise<Readonly<{
    clientId: string;
    sessionId: string;
    expiresAtEpochMs: number;
  }> | null | undefined>;
  adminClientIds: readonly string[];
}>;

export function createApiMutationInboxFactories(input: Readonly<{
  resourceInboxRepository: ResourceInboxRepository;
  resourceInboxResultsRepository: ResourceInboxResultsRepository;
  database: PSqlSql;
  serviceId: string;
  timing: RallarTimingSink | undefined;
  options: AppInboxServiceOptions;
  currentAuthority: CurrentMutationAuthority;
}>): Readonly<{
  createAppCrdtInboxService: RallarCrdtInboxServiceFactory;
  createAppAdminInboxService: RallarAdminInboxServiceFactory;
}> {
  return {
    createAppCrdtInboxService: ({ inboxQueueReader }) =>
      createApiCrdtInboxService({
        inboxQueueReader,
        resourceInboxRepository: input.resourceInboxRepository,
        resourceInboxResultsRepository: input.resourceInboxResultsRepository,
        database: input.database,
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.options,
        currentAuthority: input.currentAuthority,
      }),
    createAppAdminInboxService: ({
      inboxQueueReader,
      outboxQueueReader,
      wakeQueueEngine,
    }) => createApiAdminInboxService({
      inboxQueueReader,
      outboxQueueReader,
      wakeQueueEngine,
      resourceInboxRepository: input.resourceInboxRepository,
      resourceInboxResultsRepository: input.resourceInboxResultsRepository,
      database: input.database,
      serviceId: input.serviceId,
      timing: input.timing,
      options: input.options,
      currentAuthority: input.currentAuthority,
    }),
  };
}

export function readConfiguredAdminClientIds(): readonly string[] {
  return (Deno.env.get('AUTH_ADMIN_CLIENT_IDS') ?? 'admin')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
