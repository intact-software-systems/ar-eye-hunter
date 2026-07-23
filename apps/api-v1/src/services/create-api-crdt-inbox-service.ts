import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  AppCrdtInboxService,
} from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  createCrdtMutationService,
  type CrdtMutationCommand,
} from '@shared-server/rallar-system/services/crdt-mutations.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';

export function createApiCrdtInboxService(input: Readonly<{
  inboxQueueReader: InboxQueueReader;
  resourceInboxRepository: ResourceInboxRepository;
  resourceInboxResultsRepository: ResourceInboxResultsRepository;
  database: PSqlSql;
  serviceId: string;
  timing?: RallarTimingSink;
  options?: AppInboxServiceOptions;
  currentAuthority?: Readonly<{
    readSession(sessionId: string): Promise<Readonly<{
      clientId: string;
      sessionId: string;
      expiresAtEpochMs: number;
    }> | null | undefined>;
    adminClientIds: readonly string[];
  }>;
}>): AppCrdtInboxService {
  const authorize = async (command: CrdtMutationCommand) => {
    const session = await input.currentAuthority?.readSession(command.actor.sessionId);
    const nowEpochMs = input.options?.nowEpochMs?.() ?? Date.now();
    const allowed = Boolean(
      session &&
      session.clientId === command.actor.actorId &&
      session.sessionId === command.actor.sessionId &&
      session.expiresAtEpochMs > nowEpochMs &&
      command.responseAudience.senderSessionId === session.sessionId &&
      (command.responseAudience.kind !== 'admin' ||
        input.currentAuthority?.adminClientIds.includes(session.clientId)),
    );
    return {
      allowed,
      code: allowed ? 'allowed' : 'crdt-authority-denied',
    };
  };
  const repository = new PSqlCrdtMutationRepository(input.database, authorize);
  return new AppCrdtInboxService(
    input.inboxQueueReader,
    input.resourceInboxRepository,
    input.resourceInboxResultsRepository,
    input.database,
    createCrdtMutationService({
      repository,
      createWriter: (transaction: PSqlTransactionSql) =>
        new PSqlCrdtMutationRepository(transaction, authorize),
      serviceId: input.serviceId,
    }),
    input.serviceId,
    input.timing,
    input.options,
  );
}
