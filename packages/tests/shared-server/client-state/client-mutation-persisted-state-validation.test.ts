import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ClientPrincipalRef, ClientSession } from '@shared/api/client-types.ts';
import type { ConnectClientSessionRequest, StateScope } from '@shared/api/state-types.ts';
import {
  ClientStateRepository,
  ClientStateRepositoryInvariantCorruptionError,
} from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { ClientStateRepository as compatibilityClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import {
  clientStateInstanceStorageKey,
  clientStatePrincipalStorageKey,
  clientStateSessionStorageKey,
  decodeClientPrincipalStorageKey,
} from '@shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts';
import { clientStatePrincipalStorageKey as compatibilityClientStatePrincipalStorageKey } from '@shared-server/rallar-system/client-state-storage-keys.ts';
import {
  ClientMutationIdempotencyConflictError,
  createClientStateService as createClientMutationService,
  toClientMutationCommand,
  toClientMutationSystemAuthority,
  toExpiryCommandInput,
} from '@shared-server/rallar-system/services/client-state-service.ts';
import {
  computeClientMutation,
  type ClientMutationAuthority,
  type ClientMutationCommand,
  type ClientMutationFacts,
  type ClientMutationOperation,
  type ClientMutationRead,
  ClientMutationRejectedError,
  validateClientMutationCommand,
  validateClientMutation,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { defaultClientStateEventStoreFor } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import type {
  RuntimeStateConditionalWriteResult,
  RuntimeStateEntry,
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/repositories/session-expiry.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  createLegacyClientStateTestDriver as createClientStateService,
  failNextClientStateTestOutboxWrite,
  getClientStateTestOutbox,
} from './client-state-test-runtime.ts';
import {
  CLIENT_MUTATION_TEST_SCOPE as SCOPE,
  clientMutationPrincipalRef as principalRef,
  emptyClientMutationRead,
  invalidSessionCommand,
  validAuthoritySession,
  validFacts,
  validPrincipalCommand,
  validPrincipalValue,
} from './client-mutation-validation-test-fixtures.ts';
import {
  AggregateBarrierRepository,
  AlwaysConflictingPrincipalRepository,
  CLIENT_MUTATION_BASE_EPOCH_MS as BASE_EPOCH_MS,
  PrincipalChangeAfterFirstReadRepository,
  StatementRecordingRepository,
  connect,
  createService,
  deepFreeze,
  outboxFor,
  snapshot,
} from './client-mutation-concurrency-test-runtime.ts';

describe('client mutation persisted-state validation', () => {
  it('fails closed when a direct persisted principal read omits its workspace identity', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'principal-session', 'principal-generation', BASE_EPOCH_MS);
    await removePersistedWorkspaceId(runtime, 'client-state:principals');

    await expect(
      new ClientStateRepository(runtime).findPrincipal(principalRef('alice')),
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
  });

  it('fails closed when a persisted instance list entry omits its workspace identity', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'instance-session', 'instance-generation', BASE_EPOCH_MS);
    await removePersistedWorkspaceId(runtime, 'client-state:instances');

    await expect(
      new ClientStateRepository(runtime).listInstances(principalRef('alice')),
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
  });

  it('fails closed when a persisted session snapshot entry omits its workspace identity', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'snapshot-session', 'snapshot-generation', BASE_EPOCH_MS);
    await removePersistedWorkspaceId(runtime, 'client-state:sessions');

    await expect(
      new ClientStateRepository(runtime).readSnapshot(principalRef('alice')),
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
  });

  it('fails closed when a persisted event read omits its workspace identity', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'event-session', 'event-generation', BASE_EPOCH_MS);
    const eventStore = defaultClientStateEventStoreFor(runtime);
    const event = eventStore.events[0];
    if (!event) throw new Error('Expected a stored client event');
    const { workspaceId: ignoredWorkspaceId, ...eventWithoutWorkspaceId } = event;
    void ignoredWorkspaceId;
    eventStore.events[0] = eventWithoutWorkspaceId as typeof event;
    vi.spyOn(eventStore, 'listClientEvents').mockResolvedValue(eventStore.events);

    await expect(
      new ClientStateRepository(runtime).listEvents(principalRef('alice')),
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
  });

  it('fails closed when an active persisted session has no matching instance', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'orphan-session', 'orphan-generation', BASE_EPOCH_MS);
    const [instance] = await runtime.findAllEntries('client-state:instances');
    if (!instance) throw new Error('Expected a stored client instance');
    await runtime.deleteByKey('client-state:instances', instance.key);

    await expect(
      new ClientStateRepository(runtime).readSnapshot(principalRef('alice')),
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
  });

  it('fails closed when persisted active session ids collide across instances', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'shared-session', 'browser-generation', BASE_EPOCH_MS);
    await createService(runtime, BASE_EPOCH_MS + 1).upsertInstance(SCOPE, 'alice', 'phone', {
      platform: 'web',
      requestId: 'register-phone',
    });
    const repository = new ClientStateRepository(runtime);
    const browserSession = await repository.findSession({
      ...principalRef('alice'),
      clientInstanceId: 'browser',
      sessionId: 'shared-session',
    });
    if (!browserSession) throw new Error('Expected a stored client session');
    await repository.insertSession({
      ...browserSession,
      clientInstanceId: 'phone',
      generationId: 'phone-generation',
      connectionId: null,
    });

    await expect(repository.readSnapshot(principalRef('alice'))).rejects.toBeInstanceOf(
      ClientStateRepositoryInvariantCorruptionError,
    );
  });

  it('fails closed when a persistence list repeats a client instance', async () => {
    const runtime = new AggregateBarrierRepository();
    await connect(runtime, 'instance-session', 'instance-generation', BASE_EPOCH_MS);
    const findEntriesByPrefix = runtime.findEntriesByPrefix.bind(runtime);
    vi.spyOn(runtime, 'findEntriesByPrefix').mockImplementation(async (namespace, keyPrefix) => {
      const entries = await findEntriesByPrefix(namespace, keyPrefix);
      return namespace === 'client-state:instances' ? [...entries, ...entries] : entries;
    });

    await expect(
      new ClientStateRepository(runtime).readSnapshot(principalRef('alice')),
    ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
  });

  it('rejects malformed persisted applied receipt revision and outbox correlations on replay', async () => {
    const request = {
      username: 'alice',
      displayName: 'Alice',
      requestId: 'malformed-applied-replay',
    } as const;

    for (const variant of [
      'missing-revision',
      'divergent-revision',
      'missing-outbox',
      'wrong-outbox',
    ] as const) {
      const runtime = new AggregateBarrierRepository();
      const service = createService(runtime, 1_000);
      await service.upsertPrincipal(SCOPE, 'alice', request);
      const repository = new ClientStateRepository(runtime);
      const stored = await repository.findIdempotentClientMutationReceipt(
        principalRef('alice'),
        request.requestId,
      );
      if (!stored) throw new Error('Expected an applied client receipt');
      const [entry] = await runtime.findAllEntries('client-state:idempotent');
      if (!entry) throw new Error('Expected a persisted client receipt');
      const malformed = {
        ...stored,
        receipt: {
          ...stored.receipt,
          acceptedStorageRevision:
            variant === 'missing-revision'
              ? null
              : variant === 'divergent-revision'
                ? (stored.receipt.acceptedStorageRevision ?? 0) + 1
                : stored.receipt.acceptedStorageRevision,
          outboxIds:
            variant === 'missing-outbox'
              ? []
              : variant === 'wrong-outbox'
                ? ['wrong-outbox']
                : stored.receipt.outboxIds,
        },
      };
      await runtime.upsert(
        'client-state:idempotent',
        entry.key,
        JSON.stringify(malformed),
        Number.MAX_SAFE_INTEGER,
      );

      await expect(
        repository.findIdempotentClientMutationReceipt(principalRef('alice'), request.requestId),
        variant,
      ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
      await expect(
        service.upsertPrincipal(SCOPE, 'alice', request),
        `replay ${variant}`,
      ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    }
  });

  it('rejects malformed persisted no-op receipt revision and outbox correlations on replay', async () => {
    for (const variant of malformedNoOpVariants) {
      const runtime = new AggregateBarrierRepository();
      const service = createService(runtime, 1_000);
      await service.upsertPrincipal(SCOPE, 'alice', {
        ...malformedNoOpRequest,
        requestId: 'seed-malformed-no-op-replay',
      });
      await service.upsertPrincipal(SCOPE, 'alice', malformedNoOpRequest);
      const repository = new ClientStateRepository(runtime);
      const stored = await repository.findIdempotentClientMutationReceipt(
        principalRef('alice'),
        malformedNoOpRequest.requestId,
      );
      expect(stored?.receipt).toMatchObject({
        outcome: 'no-op',
        acceptedStorageRevision: 0,
        eventId: null,
        outboxIds: [],
      });
      if (!stored) throw new Error('Expected a no-op client receipt');
      const entry = (await runtime.findAllEntries('client-state:idempotent')).find((candidate) =>
        candidate.value.includes(malformedNoOpRequest.requestId),
      );
      if (!entry) throw new Error('Expected a persisted no-op client receipt');
      const malformed = {
        ...stored,
        receipt: {
          ...stored.receipt,
          acceptedStorageRevision:
            variant === 'missing-revision'
              ? null
              : variant === 'divergent-revision'
                ? (stored.receipt.acceptedStorageRevision ?? 0) + 1
                : stored.receipt.acceptedStorageRevision,
          outboxIds:
            variant === 'unexpected-outbox' ? ['unexpected-outbox'] : stored.receipt.outboxIds,
        },
      };
      await runtime.upsert(
        'client-state:idempotent',
        entry.key,
        JSON.stringify(malformed),
        Number.MAX_SAFE_INTEGER,
      );

      await expect(
        repository.findIdempotentClientMutationReceipt(
          principalRef('alice'),
          malformedNoOpRequest.requestId,
        ),
        variant,
      ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
      await expect(
        service.upsertPrincipal(SCOPE, 'alice', malformedNoOpRequest),
        `replay ${variant}`,
      ).rejects.toBeInstanceOf(ClientStateRepositoryInvariantCorruptionError);
    }
  });

  it('rejects malformed read entries and computed authoritative candidates', () => {
    const command = validPrincipalCommand();
    expect(() =>
      computeClientMutation({
        command,
        read: [] as unknown as ClientMutationRead,
      }),
    ).toThrow(ClientMutationRejectedError);

    const invalidRead = {
      authoritySession: validAuthoritySession(),
      idempotency: null,
      principal: {
        entry: {
          key: 'principal',
          value: '{}',
          expireAtTimestamp: 1_000,
          updatedTimestamp: 'now',
          revision: -1,
        },
        value: {
          ...validPrincipalValue(),
          snapshotVersion: Number.POSITIVE_INFINITY,
        },
      },
      instance: null,
      session: null,
      expiredSessionEntry: null,
      snapshot: null,
      receiptEvent: null,
    } as unknown as ClientMutationRead;
    expect(() => computeClientMutation({ command, read: invalidRead })).toThrow(
      ClientMutationRejectedError,
    );

    const read: ClientMutationRead = {
      authoritySession: validAuthoritySession(),
      idempotency: null,
      principal: null,
      instance: null,
      session: null,
      expiredSessionEntry: null,
      snapshot: null,
      receiptEvent: null,
    };
    const computed = computeClientMutation({ command, read });
    const invalidComputed = structuredClone(computed) as Record<string, unknown>;
    (invalidComputed.receipt as Record<string, unknown>).snapshotVersion = -1;
    expect(() =>
      validateClientMutation({
        command,
        read,
        computed: invalidComputed as unknown as typeof computed,
      }),
    ).toThrow(ClientMutationRejectedError);
  });
});

const malformedNoOpRequest = {
  username: 'alice',
  displayName: 'Alice',
  requestId: 'malformed-no-op-replay',
} as const;
const malformedNoOpVariants = [
  'missing-revision',
  'divergent-revision',
  'unexpected-outbox',
] as const;

async function removePersistedWorkspaceId(
  runtime: AggregateBarrierRepository,
  namespace: 'client-state:principals' | 'client-state:instances' | 'client-state:sessions',
): Promise<void> {
  const [entry] = await runtime.findAllEntries(namespace);
  if (!entry) throw new Error(`Expected a stored client-state ${namespace} entry`);
  const persisted = JSON.parse(entry.value) as Record<string, unknown>;
  const { workspaceId: ignoredWorkspaceId, ...persistedWithoutWorkspaceId } = persisted;
  void ignoredWorkspaceId;
  await runtime.upsert(
    namespace,
    entry.key,
    JSON.stringify(persistedWithoutWorkspaceId),
    Number.MAX_SAFE_INTEGER,
  );
}
