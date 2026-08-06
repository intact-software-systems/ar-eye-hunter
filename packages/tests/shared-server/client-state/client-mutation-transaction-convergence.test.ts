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
  createPublisher,
  createService,
  deepFreeze,
  outboxFor,
  snapshot,
} from './client-mutation-concurrency-test-runtime.ts';

describe('client mutation transaction convergence', () => {
  it('commits a deterministic outbox intent without direct publication and survives a stop before drain', async () => {
    const runtime = new AggregateBarrierRepository();
    const publisher = createPublisher();
    const service = createService(runtime, 1_000, publisher);
    const written = await service.upsertPrincipal(SCOPE, 'alice', {
      username: 'alice',
      requestId: 'stop-after-commit',
    });

    expect(written.result.right?.event?.eventType).toBe('principal-created');
    expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
    expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    const persisted = await outboxFor(runtime, ['stop-after-commit']);
    expect(persisted).toHaveLength(2);
    expect(persisted.every((entry) => entry.typeId === 'WS_OUTBOX')).toBe(true);
  });

  it('rolls back client state, receipt, event, and outbox when the insert-only outbox collides', async () => {
    const runtime = new AggregateBarrierRepository();
    const repository = new ClientStateRepository(runtime);
    const timing: RallarTimingEvent[] = [];
    failNextClientStateTestOutboxWrite(runtime);

    await expect(
      createService(runtime, 1_000, createPublisher(), (event) =>
        timing.push(event),
      ).upsertPrincipal(SCOPE, 'alice', {
        username: 'alice',
        displayName: 'Should roll back',
        requestId: 'client-outbox-collision',
      }),
    ).rejects.toMatchObject({
      code: 'resource-inbox-invariant-corruption',
    });

    expect(await repository.findPrincipal(principalRef('alice'))).toBeUndefined();
    expect(
      await repository.findIdempotentClientMutationReceipt(
        principalRef('alice'),
        'client-outbox-collision',
      ),
    ).toBeUndefined();
    expect(await repository.listEvents(principalRef('alice'))).toEqual([]);
    expect(await outboxFor(runtime, ['client-outbox-collision'])).toEqual([]);
    expect(timing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'mutation.write', status: 'error' }),
      ]),
    );
    expect(timing.map((event) => event.operation)).not.toContain('mutation.conflict');
    expect(timing.filter((event) => event.operation === 'mutation.read')).toHaveLength(1);
  });

  it('leaves retry delay scheduling outside the client service and keeps failed attempts atomic', async () => {
    const runtime = new AlwaysConflictingPrincipalRepository();
    const delays: number[] = [];
    const timing: RallarTimingEvent[] = [];
    const service = createClientStateService({
      runtimeRepository: runtime,
      syncPublisher: createPublisher(),
      now: () => 1_000,
      randomId: () => 'event-conflict',
      sleep: (delayMs: number) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
      serviceId: 'client-service',
      timing: (event) => timing.push(event),
    });

    const error = await service
      .upsertInstance(SCOPE, 'alice', 'browser', {
        platform: 'web',
        requestId: 'three-conflicts',
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RuntimeStateWriteConflictError);
    expect(delays).toEqual([]);
    expect(runtime.principalGuardCount).toBe(8);
    expect(runtime.transactionBeginCount).toBe(8);
    expect([...runtime.data.keys()].filter((key) => key.startsWith('client-state:'))).toEqual([]);
    expect(timing.filter((event) => event.operation === 'mutation.write')).toHaveLength(8);
    expect(timing.map((event) => event.operation)).not.toContain('mutation.conflict');
  });

  it('skips writes for replay, persists semantic no-op receipts, and guards principal first', async () => {
    const runtime = new StatementRecordingRepository();
    const timing: RallarTimingEvent[] = [];
    const service = createClientStateService({
      runtimeRepository: runtime,
      syncPublisher: createPublisher(),
      now: () => 1_000,
      randomId: () => 'event-order',
      sleep: () => Promise.resolve(),
      serviceId: 'client-service',
      timing: (event) => timing.push(event),
    });
    await service.upsertPrincipal(SCOPE, 'alice', {
      username: 'alice',
      displayName: 'Alice',
      requestId: 'guard-first',
    });
    expect(runtime.transactionStatements[0]).toBe('insertIfAbsent:client-state:principals');
    expect(timing.map((event) => event.operation)).toEqual(
      expect.arrayContaining([
        'mutation.read',
        'mutation.compute',
        'mutation.validate',
        'mutation.write',
      ]),
    );

    runtime.resetInstrumentation();
    timing.length = 0;
    await service.upsertPrincipal(SCOPE, 'alice', {
      username: 'alice',
      displayName: 'Alice',
      requestId: 'guard-first',
    });
    expect(runtime.transactionBeginCount).toBe(0);
    expect(runtime.transactionStatements).toEqual([]);
    expect(timing.map((event) => event.operation)).toEqual(
      expect.arrayContaining(['mutation.read', 'mutation.compute', 'mutation.validate']),
    );
    expect(timing.map((event) => event.operation)).not.toContain('mutation.write');

    timing.length = 0;
    await service.upsertPrincipal(SCOPE, 'alice', {
      username: 'alice',
      displayName: 'Alice',
      requestId: 'semantic-no-op',
    });
    expect(runtime.transactionBeginCount).toBe(1);
    expect(runtime.transactionStatements).toEqual(['insertIfAbsent:client-state:idempotent']);
    expect(timing.map((event) => event.operation)).toContain('mutation.write');
  });
});
