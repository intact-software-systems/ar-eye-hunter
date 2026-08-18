import { expect, expectTypeOf, it } from 'vitest';

import type {
  RallarCrdtAdminReadRepository,
  RallarCrdtValidationResult,
} from '@shared/crdt/mod.ts';
import * as sharedServer from '@shared-server/mod.ts';
import {
  InMemoryRallarCrdtLogRepository,
  type InMemoryRallarCrdtLogRepositoryOptions,
} from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
import {
  RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES,
  RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES,
  type RallarCrdtServerAcceptedEnvelope,
  type RallarCrdtServerDocumentAuthorizationInput,
  type RallarCrdtServerEnvelopeKind,
  type RallarCrdtServerLiveValidationContext,
  type RallarCrdtServerMutationIngress,
  type RallarCrdtServerPrincipalFanoutInput,
  type RallarCrdtServerTopicBridge,
  type RallarCrdtServerTopicBridgeOptions,
  type RallarCrdtServerTopicScope,
  type RallarCrdtServerTrustedMetadata,
  type RallarCrdtServerWsTopicInstaller,
} from '@shared-server/rallar-system/crdt/realtime/rallar-crdt-server-contracts.ts';
import {
  type ValidateRallarCrdtServerLiveEnvelopeInput,
  validateRallarCrdtServerLiveEnvelope,
} from '@shared-server/rallar-system/crdt/realtime/validate-rallar-crdt-server-live-envelope.ts';
import {
  PSqlCrdtLogRepository,
  type PSqlCrdtLogRepositoryOptions,
} from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

it('keeps the package CRDT log repository on its canonical owner', () => {
  expect(sharedServer.PSqlCrdtLogRepository).toBe(PSqlCrdtLogRepository);
});

it('keeps public CRDT runtime values on their canonical owners', () => {
  expect(sharedServer.InMemoryRallarCrdtLogRepository).toBe(InMemoryRallarCrdtLogRepository);
  expect(sharedServer.installRallarCrdtWsTopics).toBe(installRallarCrdtWsTopics);
  expect(sharedServer.validateRallarCrdtServerLiveEnvelope).toBe(
    validateRallarCrdtServerLiveEnvelope,
  );
  expect(sharedServer.RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES).toBe(
    RALLAR_CRDT_SERVER_DEFAULT_MAX_UPDATE_BYTES,
  );
  expect(sharedServer.RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES).toBe(
    RALLAR_CRDT_SERVER_DEFAULT_MAX_SYNC_BYTES,
  );
});

it('keeps the public live-envelope validator on its named-input package contract', () => {
  expectTypeOf(validateRallarCrdtServerLiveEnvelope).toEqualTypeOf<
    (input: ValidateRallarCrdtServerLiveEnvelopeInput) => RallarCrdtValidationResult
  >();

  const result = validateRallarCrdtServerLiveEnvelope({
    kind: 'sync-request',
    topicScope: 'app',
    value: undefined,
    context: { topicId: 'app.crdt', typeId: 'app.crdt.sync.request' },
    options: {},
  });
  expect(result.valid).toBe(false);
});

it('keeps every public CRDT server and in-memory repository type on the package root', () => {
  expectTypeOf<sharedServer.RallarCrdtServerEnvelopeKind>().toEqualTypeOf<RallarCrdtServerEnvelopeKind>();
  expectTypeOf<sharedServer.RallarCrdtServerTopicScope>().toEqualTypeOf<RallarCrdtServerTopicScope>();
  expectTypeOf<sharedServer.RallarCrdtServerTrustedMetadata>().toEqualTypeOf<RallarCrdtServerTrustedMetadata>();
  expectTypeOf<sharedServer.RallarCrdtServerAcceptedEnvelope>().toEqualTypeOf<RallarCrdtServerAcceptedEnvelope>();
  expectTypeOf<sharedServer.RallarCrdtServerMutationIngress>().toEqualTypeOf<RallarCrdtServerMutationIngress>();
  expectTypeOf<sharedServer.RallarCrdtServerDocumentAuthorizationInput>().toEqualTypeOf<RallarCrdtServerDocumentAuthorizationInput>();
  expectTypeOf<sharedServer.RallarCrdtServerTopicBridgeOptions>().toEqualTypeOf<RallarCrdtServerTopicBridgeOptions>();
  expectTypeOf<sharedServer.RallarCrdtServerPrincipalFanoutInput>().toEqualTypeOf<RallarCrdtServerPrincipalFanoutInput>();
  expectTypeOf<sharedServer.RallarCrdtServerTopicBridge>().toEqualTypeOf<RallarCrdtServerTopicBridge>();
  expectTypeOf<sharedServer.RallarCrdtServerWsTopicInstaller>().toEqualTypeOf<RallarCrdtServerWsTopicInstaller>();
  expectTypeOf<sharedServer.RallarCrdtServerLiveValidationContext>().toEqualTypeOf<RallarCrdtServerLiveValidationContext>();
  expectTypeOf<sharedServer.ValidateRallarCrdtServerLiveEnvelopeInput>().toEqualTypeOf<ValidateRallarCrdtServerLiveEnvelopeInput>();
  expectTypeOf<sharedServer.InMemoryRallarCrdtLogRepositoryOptions>().toEqualTypeOf<InMemoryRallarCrdtLogRepositoryOptions>();
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
