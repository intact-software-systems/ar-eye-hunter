import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
// prettier-ignore
import { PSqlCrdtMutationRepository } from '@shared-server/rallar-system/crdt/persistence/\
psql-crdt-mutation-repository.ts';
// prettier-ignore
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxRepository.ts';
// prettier-ignore
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/\
ResourceInboxResultsRepository.ts';
// prettier-ignore
import { AppCrdtInboxService } from '@shared-server/rallar-system/services/\
AppCrdtInboxService.ts';
// prettier-ignore
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/\
AppInboxService.ts';
import type * as Crdt from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import {
  createCrdtMutationService,
} from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { CurrentMutationAuthority } from './create-api-mutation-inbox-factories.ts';

export interface CreateApiCrdtInboxServiceInput {
  readonly inboxQueueReader: InboxQueueReader;
  readonly resourceInboxRepository: ResourceInboxRepository;
  readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly timing?: RallarTimingSink;
  readonly options?: AppInboxServiceOptions;
  readonly currentAuthority: CurrentMutationAuthority;
  readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  readonly outboxQueueReader?: OutboxQueueReader;
  readonly wakeQueueEngine?: () => void;
}

export function createApiCrdtInboxService(
  input: CreateApiCrdtInboxServiceInput,
): AppCrdtInboxService {
  const { currentAuthority, policies } = input;
  const authorize = async (command: Crdt.CrdtMutationCommand) => {
    const session = await currentAuthority.readSession(command.actor.sessionId);
    const nowEpochMs = input.options?.nowEpochMs?.() ?? Date.now();
    if (!session) {
      return { allowed: false, code: 'authentication-missing' };
    }
    if (session.expiresAtEpochMs <= nowEpochMs) {
      return { allowed: false, code: 'authentication-expired' };
    }
    if (
      session.clientId !== command.actor.actorId ||
      session.username !== command.actor.principalId ||
      session.sessionId !== command.actor.sessionId ||
      command.responseAudience.senderSessionId !== session.sessionId
    ) {
      return { allowed: false, code: 'authorization-forbidden' };
    }
    if (command.responseAudience.kind === 'admin') {
      const allowed = currentAuthority.adminClientIds.includes(session.clientId);
      return { allowed, code: allowed ? 'allowed' : 'authorization-forbidden' };
    }
    return await currentAuthority.authorizeDocument(command, session);
  };
  const repository = new PSqlCrdtMutationRepository(
    { sql: input.database, authorize },
    { policies },
  );
  return new AppCrdtInboxService({
    inbox: input.inboxQueueReader,
    resourceInbox: input.resourceInboxRepository,
    resourceInboxResults: input.resourceInboxResultsRepository,
    database: input.database,
    mutationService: createCrdtMutationService({
      repository,
      createWriter: (transaction: PSqlTransactionSql) =>
        new PSqlCrdtMutationRepository({ sql: transaction, authorize }, { policies }),
      serviceId: input.serviceId,
    }),
    serviceId: input.serviceId,
    timing: input.timing,
    options: input.options,
    effects: {
      outboxQueueReader: input.outboxQueueReader,
      wakeQueueEngine: input.wakeQueueEngine,
      resolveCurrentSession: async (sessionId, atEpochMs) => {
        const session = await currentAuthority.readSession(sessionId);
        if (!session || session.expiresAtEpochMs <= atEpochMs) {
          throw Object.assign(new Error('CRDT current session is unavailable'), {
            code: 'authentication-missing',
            status: 401,
          });
        }
        if (session.sessionId !== sessionId) {
          throw Object.assign(new Error('CRDT current session identity differs'), {
            code: 'authorization-forbidden',
            status: 403,
          });
        }
        return session;
      },
    },
  });
}
