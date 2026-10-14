import {
    expect,
    it,
    vi
} from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';

vi.mock(import('@shared/alm/inbound/al-inbound-admission-store.ts'), async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, createALInboundAdmissionStore: vi.fn(original.createALInboundAdmissionStore) };
});

it('constructs the WS server\'s shared inbound store without an ordering-track cap', () => {
    // Construction issues no statement, so a store that is never read needs no database.
    const sql = {} as PSqlSql;

    createPSqlALInboundRuntimeStores({
        nowMs: Date.now,
        repository: new PSqlRuntimeStateRepository(sql),
        namespace: 'server-ws-qbox:uncapped',
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined
    });

    expect(vi.mocked(createALInboundAdmissionStore)).toHaveBeenCalledWith(
        expect.objectContaining({ maxOrderingTracks: undefined })
    );
});
