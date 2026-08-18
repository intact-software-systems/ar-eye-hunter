import { expect, expectTypeOf, it } from 'vitest';

import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';
import * as sharedServer from '@shared-server/mod.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';

it('keeps the package CRDT log repository on its canonical owner', () => {
  expect(sharedServer.PSqlCrdtLogRepository).toBe(PSqlCrdtLogRepository);
});

it('exposes only supported read and administration operations at the PostgreSQL boundary', () => {
  expectTypeOf<PSqlCrdtLogRepository>().toExtend<RallarCrdtAdminReadRepository>();
  expectTypeOf<RallarCrdtAdminReadRepository>().not.toHaveProperty('append');
  expectTypeOf<RallarCrdtAdminReadRepository>().not.toHaveProperty('appendBatch');
  expectTypeOf<RallarCrdtAdminReadRepository>().not.toHaveProperty('writeSnapshot');
  expectTypeOf<RallarCrdtAdminReadRepository>().not.toHaveProperty('updateDocumentLifecycle');
  expectTypeOf<RallarCrdtAdminReadRepository>().not.toHaveProperty('restoreBackupBundle');
  expectTypeOf<RallarCrdtAdminReadRepository>().not.toHaveProperty('rebuildProjection');
});
