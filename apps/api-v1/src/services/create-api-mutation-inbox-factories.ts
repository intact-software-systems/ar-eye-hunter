import type {
  RallarAdminInboxServiceFactory,
  RallarCrdtInboxServiceFactory,
} from '@shared-server/rallar-system/middleware/rallar-middleware-options.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type * as Crdt from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import type { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import type { AppInboxServiceOptions } from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/services/timing.ts';
import { createApiAdminInboxService } from './create-api-admin-inbox-service.ts';
import { createApiCrdtInboxService } from './create-api-crdt-inbox-service.ts';
import {
  decodeRallarCrdtDocumentTypePolicies,
  type RallarCrdtDocumentTypePolicy,
} from '@shared/crdt/mod.ts';

export interface CurrentMutationSession {
  readonly clientId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly expiresAtEpochMs: number;
}

export interface CurrentMutationAuthority {
  readonly readSession: (sessionId: string) => Promise<
    | CurrentMutationSession
    | null
    | undefined
  >;
  readonly authorizeDocument: (
    command: Crdt.CrdtMutationCommand,
    session: CurrentMutationSession,
  ) => Promise<Readonly<{ allowed: boolean; code: string }>>;
  readonly adminClientIds: readonly string[];
}

export interface CreateApiMutationInboxFactoriesInput {
  readonly resourceInboxRepository: ResourceInboxRepository;
  readonly resourceInboxResultsRepository: ResourceInboxResultsRepository;
  readonly database: PSqlSql;
  readonly serviceId: string;
  readonly timing: RallarTimingSink | undefined;
  readonly options: AppInboxServiceOptions;
  readonly currentAuthority: CurrentMutationAuthority;
  readonly crdtPolicies: readonly RallarCrdtDocumentTypePolicy[];
}

export interface ApiMutationInboxFactories {
  readonly createAppCrdtInboxService: RallarCrdtInboxServiceFactory;
  readonly createAppAdminInboxService: RallarAdminInboxServiceFactory;
}

export interface CreateConfiguredApiMutationInboxFactoriesInput
  extends Omit<CreateApiMutationInboxFactoriesInput, 'currentAuthority' | 'crdtPolicies'> {
  readonly readSession: CurrentMutationAuthority['readSession'];
  readonly authorizeDocument: CurrentMutationAuthority['authorizeDocument'];
}

export function createApiMutationInboxFactories(
  input: CreateApiMutationInboxFactoriesInput,
): ApiMutationInboxFactories {
  return {
    createAppCrdtInboxService: ({ inboxQueueReader, outboxQueueReader, wakeQueueEngine }) =>
      createApiCrdtInboxService({
        inboxQueueReader,
        resourceInboxRepository: input.resourceInboxRepository,
        resourceInboxResultsRepository: input.resourceInboxResultsRepository,
        database: input.database,
        serviceId: input.serviceId,
        timing: input.timing,
        options: input.options,
        currentAuthority: input.currentAuthority,
        policies: input.crdtPolicies,
        outboxQueueReader,
        wakeQueueEngine,
      }),
    createAppAdminInboxService: ({
      inboxQueueReader,
      outboxQueueReader,
      wakeQueueEngine,
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
        currentAuthority: input.currentAuthority,
      }),
  };
}

export function createConfiguredApiMutationInboxFactories(
  input: CreateConfiguredApiMutationInboxFactoriesInput,
): ApiMutationInboxFactories {
  const { readSession, authorizeDocument, ...base } = input;
  return createApiMutationInboxFactories({
    ...base,
    currentAuthority: {
      readSession,
      authorizeDocument,
      adminClientIds: readConfiguredAdminClientIds(),
    },
    crdtPolicies: readConfiguredCrdtPolicies(),
  });
}

export function readConfiguredAdminClientIds(): readonly string[] {
  return (Deno.env.get('AUTH_ADMIN_CLIENT_IDS') ?? 'admin')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function readConfiguredCrdtPolicies(): readonly RallarCrdtDocumentTypePolicy[] {
  const source = Deno.env.get('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
  if (!source) {
    return resolveApiCrdtPolicies(undefined);
  }
  return resolveApiCrdtPolicies(
    decodeRallarCrdtDocumentTypePolicies(JSON.parse(source) as unknown),
  );
}

export function resolveApiCrdtPolicies(
  policies: readonly RallarCrdtDocumentTypePolicy[] | undefined,
): readonly RallarCrdtDocumentTypePolicy[] {
  return policies && policies.length > 0 ? policies : [{ documentType: '*', rollout: 'disabled' }];
}
