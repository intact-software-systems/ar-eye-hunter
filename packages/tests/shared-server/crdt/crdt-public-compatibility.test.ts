import { expect, expectTypeOf, it } from 'vitest';

import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import * as sharedServer from '@shared-server/mod.ts';
import {
  PSqlCrdtLogRepository,
  type PSqlCrdtLogRepositoryOptions,
} from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

it('keeps the package CRDT log repository on its canonical owner', () => {
  expect(sharedServer.PSqlCrdtLogRepository).toBe(PSqlCrdtLogRepository);
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
