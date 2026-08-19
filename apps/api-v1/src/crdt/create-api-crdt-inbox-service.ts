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
import { AppCrdtInboxService } from '@shared-server/rallar-system/crdt/inbox/\
app-crdt-inbox-service.ts';
// prettier-ignore
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/\
AppInboxService.ts';
import type * as Crdt from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import {
  createCrdtMutationService,
} from '@shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import type { RallarCrdtDocumentTypePolicy } from '@shared/crdt/mod.ts';

export interface CurrentMutationSession {
  readonly clientId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly expiresAtEpochMs: number;
}

export interface CurrentMutationDocumentAuthorization {
  readonly allowed: boolean;
  readonly code: string;
}

export interface CurrentMutationAuthority {
  readSession(sessionId: string): Promise<
    | CurrentMutationSession
    | null
    | undefined
  >;
  authorizeDocument(
    command: Crdt.CrdtMutationCommand,
    session: CurrentMutationSession,
  ): Promise<CurrentMutationDocumentAuthorization>;
  readonly adminClientIds: readonly string[];
}

export interface CreateApiCrdtInboxServiceInput {
  readonly inboxQueueReader: InboxQueueReader;
  readonly resourceInboxRepository: ResourceInboxRepository;
  readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly timing: RallarTimingSink | undefined;
  readonly options: AppInboxServiceOptions;
  readonly currentAuthority: CurrentMutationAuthority;
  readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  readonly wakeQueueEngine: () => void;
  readonly auditDelivery?: AppCrdtInboxService.AuditDelivery;
}

interface ApiCrdtMutationAuthorizationDependencies {
  readonly currentAuthority: CurrentMutationAuthority;
  readonly nowEpochMs: () => number;
}

export function createApiCrdtInboxService(
  input: CreateApiCrdtInboxServiceInput,
): AppCrdtInboxService {
  const { currentAuthority, policies } = input;
  const authorize = createApiCrdtMutationAuthorizer({
    currentAuthority,
    nowEpochMs: input.options.nowEpochMs ?? Date.now,
  });
  const repository = new PSqlCrdtMutationRepository(
    { sql: input.database, authorize },
    { policies },
  );
  return new AppCrdtInboxService(
    {
      inboxQueueReader: input.inboxQueueReader,
      resourceInboxRepository: input.resourceInboxRepository,
      resourceInboxResultsRepository: input.resourceInboxResultsRepository,
      database: input.database,
      mutationService: createCrdtMutationService({
        repository,
        createWriter: (transaction: PSqlTransactionSql) =>
          new PSqlCrdtMutationRepository({ sql: transaction, authorize }, { policies }),
        serviceId: input.serviceId,
      }),
      readCurrentSession: async ({ sessionId, atEpochMs }) => {
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
      wakeQueueEngine: input.wakeQueueEngine,
      auditDelivery: input.auditDelivery,
    },
    {
      serviceId: input.serviceId,
      timing: input.timing,
      appInbox: input.options,
    },
  );
}

function createApiCrdtMutationAuthorizer(
  dependencies: ApiCrdtMutationAuthorizationDependencies,
): (
  command: Crdt.CrdtMutationCommand,
) => Promise<CurrentMutationDocumentAuthorization> {
  return async (command) => {
    const session = await dependencies.currentAuthority.readSession(command.actor.sessionId);
    const nowEpochMs = dependencies.nowEpochMs();
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
      const allowed = dependencies.currentAuthority.adminClientIds.includes(session.clientId);
      return { allowed, code: allowed ? 'allowed' : 'authorization-forbidden' };
    }
    return await dependencies.currentAuthority.authorizeDocument(command, session);
  };
}
