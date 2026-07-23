import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  AppCrdtInboxService,
} from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/services/crdt-mutations.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';

export function createApiCrdtInboxService(input: Readonly<{
  inboxQueueReader: InboxQueueReader;
  resourceInboxRepository: ResourceInboxRepository;
  resourceInboxResultsRepository: ResourceInboxResultsRepository;
  database: PSqlSql;
  serviceId: string;
  timing?: RallarTimingSink;
  options?: AppInboxServiceOptions;
}>): AppCrdtInboxService {
  const repository = new PSqlCrdtMutationRepository(input.database);
  return new AppCrdtInboxService(
    input.inboxQueueReader,
    input.resourceInboxRepository,
    input.resourceInboxResultsRepository,
    input.database,
    createCrdtMutationService({
      repository,
      createWriter: (transaction: PSqlTransactionSql) =>
        new PSqlCrdtMutationRepository(transaction),
      serviceId: input.serviceId,
    }),
    input.serviceId,
    input.timing,
    input.options,
  );
}
