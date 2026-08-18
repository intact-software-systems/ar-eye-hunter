import { expect, expectTypeOf, it } from 'vitest';

import type {
  RallarCrdtAdminReadRepository,
  RallarCrdtValidationResult,
} from '@shared/crdt/mod.ts';
import * as sharedServer from '@shared-server/mod.ts';
import {
  type RallarCrdtServerEnvelopeKind,
  type RallarCrdtServerLiveValidationContext,
  type RallarCrdtServerTopicBridgeOptions,
  type RallarCrdtServerTopicScope,
  validateRallarCrdtServerLiveEnvelope,
} from '@shared-server/crdt/RallarCrdtServer.ts';
import {
  PSqlCrdtLogRepository,
  type PSqlCrdtLogRepositoryOptions,
} from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

it('keeps the package CRDT log repository on its canonical owner', () => {
  expect(sharedServer.PSqlCrdtLogRepository).toBe(PSqlCrdtLogRepository);
});

it('keeps the public live-envelope validator on its five-argument package contract', () => {
  expect(sharedServer.validateRallarCrdtServerLiveEnvelope).toBe(
    validateRallarCrdtServerLiveEnvelope,
  );
  expectTypeOf(validateRallarCrdtServerLiveEnvelope).toEqualTypeOf<
    (
      kind: RallarCrdtServerEnvelopeKind,
      topicScope: RallarCrdtServerTopicScope,
      value: unknown,
      context: RallarCrdtServerLiveValidationContext,
      options?: RallarCrdtServerTopicBridgeOptions,
    ) => RallarCrdtValidationResult
  >();

  const result = validateRallarCrdtServerLiveEnvelope(
    'sync-request',
    'app',
    undefined,
    { topicId: 'app.crdt', typeId: 'app.crdt.sync.request' },
    {},
  );
  expect(result.valid).toBe(false);
});

it('limits the concrete PostgreSQL repository to supported read and administration operations', () => {
  expectTypeOf<PSqlCrdtLogRepository>().toExtend<RallarCrdtAdminReadRepository>();
  expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('append');
  expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('appendBatch');
  expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('writeSnapshot');
  expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('updateDocumentLifecycle');
  expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('restoreBackupBundle');
  expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('rebuildProjection');
});

it('limits concrete PostgreSQL repository options to the values the owner reads', () => {
  expectTypeOf<keyof PSqlCrdtLogRepositoryOptions>().toEqualTypeOf<'now' | 'policies' | 'audit'>();
  expectTypeOf<PSqlCrdtLogRepositoryOptions>().not.toHaveProperty('serverId');
  expectTypeOf<PSqlCrdtLogRepositoryOptions>().not.toHaveProperty('validation');
  expectTypeOf<PSqlCrdtLogRepositoryOptions>().not.toHaveProperty('metrics');
});
