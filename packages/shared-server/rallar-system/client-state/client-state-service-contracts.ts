import type {
  ClientEvent,
  ClientPlatform,
  ClientPresenceSnapshot,
  ClientPrincipalRef,
  ClientScope,
  ClientSession,
  ClientSnapshot,
} from '@shared/api/client-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { Either } from '@shared/resilience/Either.ts';
// prettier-ignore
import type {
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import type { ClientSessionExpiryCandidate } from '../repositories/session-expiry.ts';
import type { ClientStateEventStore } from '../repositories/StateEventStore.ts';
import type { PersistedAuthSession } from '../auth/persistence/auth-persistence-contracts.ts';
import type { StateEventListQuery } from '../state-event-listing.ts';
// prettier-ignore
import {
  assertNeverClientMutationComputed,
} from './mutation/compute/compute-client-mutation-result.ts';
import type {
  ClientMutationCommand,
  ClientMutationComputed,
  ClientMutationComputedWrite,
  ClientMutationRead,
  ClientMutationReceipt,
} from './mutation/client-mutation-contracts.ts';
// prettier-ignore
import type {
  WsSessionGenerationLifecycleService,
} from '../services/ws-session-generation-lifecycle.ts';

export type RegisterAuthorisedWsClientInput = Readonly<{
  applicationId?: string;
  workspaceId?: string;
  principalId?: string;
  clientInstanceId?: string;
  displayName?: string;
  userAgent?: string;
  platform?: ClientPlatform;
  capabilities?: readonly string[];
  connectedAtEpochMs?: number;
  expiresAtEpochMs?: number;
}>;

export type ClientMutationWritten = Readonly<{
  snapshot: ClientSnapshot;
  event: ClientEvent | null;
}>;

export type ClientStateWritten = Readonly<{
  status: 'ok';
  result: Either<string, ClientMutationWritten>;
}>;

export type ClientStateService = Readonly<{
  sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
  listSnapshots(scope: ClientScope): Promise<readonly ClientSnapshot[]>;
  readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
  readPresenceSnapshot(ref: ClientPrincipalRef): Promise<ClientPresenceSnapshot | undefined>;
  listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
  listRecentEvents?(
    ref: ClientPrincipalRef,
    query: StateEventListQuery,
  ): Promise<readonly ClientEvent[]>;
  listEventPage(
    ref: ClientPrincipalRef,
    query: StateEventListQuery,
  ): Promise<StateEventPage<ClientEvent>>;
  read(command: ClientMutationCommand): Promise<ClientMutationRead>;
  compute(command: ClientMutationCommand, read: ClientMutationRead): ClientMutationComputed;
  validate(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    computed: ClientMutationComputed,
  ): void;
  write(
    transaction: PSqlTransactionSql,
    computed: ClientMutationComputedWrite,
  ): Promise<ClientMutationReceipt>;
  listExpiredSessionCandidates(atEpochMs: number): Promise<readonly ClientSessionExpiryCandidate[]>;
  findSessionBySessionId(sessionId: string): Promise<ClientSession | undefined>;
  readIssuedAuthSession(sessionId: string): Promise<PersistedAuthSession | undefined>;
  observeSnapshot(snapshot: ClientSnapshot): Promise<ClientSnapshot>;
}>;

export type ClientStateMutationService = Pick<
  ClientStateService,
  'read' | 'compute' | 'validate' | 'write'
>;

export type ClientStateServiceDependencies = Readonly<{
  runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike;
  createClientStateEventStore?: (
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike,
  ) => ClientStateEventStore;
  serviceId: string;
  timing?: import('../services/timing.ts').RallarTimingSink;
}>;

export function requiresClientWrite(
  computed: ClientMutationComputed,
): computed is ClientMutationComputedWrite {
  switch (computed.outcome) {
    case 'write':
      return true;
    case 'no-op':
      return computed.persistIdempotency;
    case 'replay':
    case 'idempotency-conflict':
      return false;
    default:
      return assertNeverClientMutationComputed(computed);
  }
}

export function toClientMutationReceipt(
  computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict' }>,
): ClientMutationReceipt {
  return computed.receipt;
}

export function toClientStateWritten(
  computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict' }>,
): ClientStateWritten {
  switch (computed.outcome) {
    case 'write':
    case 'no-op':
    case 'replay':
      break;
    default:
      return assertNeverClientMutationComputed(computed);
  }
  return {
    status: 'ok',
    result: Either.ofRight({
      snapshot: computed.snapshot,
      event: computed.event,
    }),
  };
}
