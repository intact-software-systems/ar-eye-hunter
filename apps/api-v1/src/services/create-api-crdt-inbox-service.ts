import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlCrdtMutationRepository } from '@shared-server/postgres/crdt/PSqlCrdtMutationRepository.ts';
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { AppCrdtInboxService } from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import type * as Crdt from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import { createCrdtMutationService } from '@shared-server/rallar-system/services/crdt-mutations.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { CurrentMutationAuthority } from './create-api-mutation-inbox-factories.ts';

export function createApiCrdtInboxService(
  input: Readonly<{
    inboxQueueReader: InboxQueueReader;
    resourceInboxRepository: ResourceInboxRepository;
    resourceInboxResultsRepository: ResourceInboxResultsRepository;
    database: PSqlSql;
    serviceId: string;
    timing?: RallarTimingSink;
    options?: AppInboxServiceOptions;
    currentAuthority?: CurrentMutationAuthority;
    policies?: readonly RallarCrdtDocumentTypePolicy[];
    outboxQueueReader?: OutboxQueueReader;
    wakeQueueEngine?: () => void;
  }>,
): AppCrdtInboxService {
  const authorize = async (command: Crdt.CrdtMutationCommand) => {
    const session = await input.currentAuthority?.readSession(command.actor.sessionId);
    const nowEpochMs = input.options?.nowEpochMs?.() ?? Date.now();
    if (!session) return { allowed: false, code: 'authentication-missing' };
    if (session.expiresAtEpochMs <= nowEpochMs) {
      return { allowed: false, code: 'authentication-expired' };
    }
    if (
      session.clientId !== command.actor.actorId ||
      session.username !== command.actor.principalId ||
      session.sessionId !== command.actor.sessionId ||
      command.responseAudience.senderSessionId !== session.sessionId
    ) return { allowed: false, code: 'authorization-forbidden' };
    if (command.responseAudience.kind === 'admin') {
      const allowed = Boolean(input.currentAuthority?.adminClientIds.includes(session.clientId));
      return { allowed, code: allowed ? 'allowed' : 'authorization-forbidden' };
    }
    if (!input.currentAuthority) {
      return { allowed: false, code: 'authorization-scope-denied' };
    }
    return await input.currentAuthority.authorizeDocument(command, session);
  };
  const policies = input.policies && input.policies.length > 0
    ? input.policies
    : [{ documentType: '*', rollout: 'disabled' as const }];
  const repository = new PSqlCrdtMutationRepository(input.database, authorize, policies);
  return new AppCrdtInboxService(
    input.inboxQueueReader,
    input.resourceInboxRepository,
    input.resourceInboxResultsRepository,
    input.database,
    createCrdtMutationService({
      repository,
      createWriter: (transaction: PSqlTransactionSql) =>
        new PSqlCrdtMutationRepository(transaction, authorize, policies),
      serviceId: input.serviceId,
    }),
    input.serviceId,
    input.timing,
    input.options,
    {
      outboxQueueReader: input.outboxQueueReader,
      wakeQueueEngine: input.wakeQueueEngine,
      resolveCurrentSession: async (sessionId, atEpochMs) => {
        const session = await input.currentAuthority?.readSession(sessionId);
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
  );
}
