import { expectTypeOf, it } from 'vitest';

import { PSqlCrdtLogRepository, type PSqlCrdtLogRepositoryOptions } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';
import type { RallarCrdtAdminReadRepository } from '@shared/crdt/mod.ts';

it('limits the PostgreSQL repository to supported read and administration operations', () => {
    expectTypeOf<PSqlCrdtLogRepository>().toExtend<RallarCrdtAdminReadRepository>();
    expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('append');
    expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('appendBatch');
    expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('writeSnapshot');
    expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('updateDocumentLifecycle');
    expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('restoreBackupBundle');
    expectTypeOf<PSqlCrdtLogRepository>().not.toHaveProperty('rebuildProjection');
});

it('requires only the configuration read by the PostgreSQL owner', () => {
    expectTypeOf<keyof PSqlCrdtLogRepositoryOptions>().toEqualTypeOf<'now' | 'policies' | 'audit'>();
    expectTypeOf<PSqlCrdtLogRepositoryOptions>().not.toHaveProperty('serverId');
    expectTypeOf<PSqlCrdtLogRepositoryOptions>().not.toHaveProperty('validation');
    expectTypeOf<PSqlCrdtLogRepositoryOptions>().not.toHaveProperty('metrics');
});
