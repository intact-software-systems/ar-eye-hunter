import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlAdminPruneExpiredRepository } from '@shared-server/postgres/admin-operations/PSqlAdminPruneExpiredRepository.ts';
import {
  PSqlAdminOperationsPruner,
} from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
  AdminPruneExpiredWork,
} from '@shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts';
import {
  AppAdminInboxService,
} from '@shared-server/rallar-system/services/AppAdminInboxService.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';

export function createApiAdminInboxService(input: Readonly<{
  inboxQueueReader: InboxQueueReader;
  outboxQueueReader: OutboxQueueReader;
  wakeQueueEngine: () => void;
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
}>): AppAdminInboxService {
  const pageSize = 100;
  const readAuthority = async (authority: Readonly<{
    requestedBy: string;
    requestedSessionId: string;
    nowEpochMs: number;
  }>) => {
    const session = await input.currentAuthority?.readSession(
      authority.requestedSessionId,
    );
    const allowed = Boolean(
      session &&
      session.clientId === authority.requestedBy &&
      session.sessionId === authority.requestedSessionId &&
      session.expiresAtEpochMs > authority.nowEpochMs &&
      input.currentAuthority?.adminClientIds.includes(session.clientId),
    );
    return {
      allowed,
      code: allowed ? 'allowed' : 'admin-prune-authority-denied',
    };
  };
  const pageWork = new AdminPruneExpiredWork({
    database: input.database,
    repository: new PSqlAdminPruneExpiredRepository(input.database, input.serviceId),
    serviceId: input.serviceId,
    pageSize,
    now: input.options?.nowEpochMs,
    readAuthority,
    wakeQueue: input.wakeQueueEngine,
  });
  input.outboxQueueReader.onOutboxMessageDo(AppInboxType.ADMIN_PRUNE_EXPIRED, {
    onMessage: async (_message, entry) => await pageWork.processReservedEntry(entry),
  });
  return new AppAdminInboxService(
    input.inboxQueueReader,
    input.resourceInboxRepository,
    input.resourceInboxResultsRepository,
    input.database,
    new PSqlAdminOperationsPruner(input.database),
    input.serviceId,
    pageSize,
    input.timing,
    input.options,
    readAuthority,
  );
}
