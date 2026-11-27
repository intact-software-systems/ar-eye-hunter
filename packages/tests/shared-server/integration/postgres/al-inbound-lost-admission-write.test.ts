import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it
} from 'vitest';

import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundCommitBundle } from '@shared/alm/inbound/al-inbound-admission-store.ts';

import {
    createInboundTestMessage,
    createInboundTestOrderedDelivery,
    readInboundTestAdmission
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    admitPostgresInboundTestMessage,
    createPostgresInboundAdmissionStore
} from './test-support/create-postgres-inbound-admission-store.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const RUN_ID = `al-inbound-lost-admission-write-${crypto.randomUUID()}`;
const NAMESPACE = `inbound-lost-admission-write-${RUN_ID}`;

describe('Postgres inbound admission after a lost write', () => {
    let admitting: PostgresSql | undefined;
    let completing: PostgresSql | undefined;

    beforeAll(async () => {
        if (process.env.RALLAR_POSTGRES_INTEGRATION === '1') {
            admitting = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            completing = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        }
    });

    afterAll(async () => {
        if (admitting !== undefined && completing !== undefined) {
            try {
                await deletePostgresRunRows(admitting, RUN_ID);
                expect(await readPostgresRunRowCounts(admitting, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await admitting.end();
                await completing.end();
            }
        }
    });

    // A fresh attempt is worth making only if its read sees the commit that beat the lost write: a read served from a
    // snapshot older than that commit would lose again, and the arrival would be parked however often it looked.
    postgresIt('reads the winner at once after an admission lost its row version to its predecessor\'s completion', async () => {
        const admittingStore = createPostgresInboundAdmissionStore(admitting!, NAMESPACE);
        const completingStore = createPostgresInboundAdmissionStore(completing!, NAMESPACE);
        const first = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
        const second = createInboundTestMessage({ msgId: 'message-2', seq: 2 });
        await admitPostgresInboundTestMessage(admittingStore, first);
        const stale = await readInboundTestAdmission(admittingStore, second);
        expect(await createInboundTestOrderedDelivery(completingStore).complete(first)).toEqual({
            kind: 'completed',
            position: { trackKey: toALOrderingTrackKey(first), completedThrough: 1 }
        });

        expect(await admittingStore.commitBundle(stale)).toBe('conflict');
        const fresh = await readInboundTestAdmission(admittingStore, second);
        expect(await admittingStore.commitBundle(fresh)).toBe('committed');

        expect(stale.observations.deliveryProgress?.value?.completedThrough ?? 0).toBe(0);
        expect(fresh.observations.deliveryProgress?.value?.completedThrough).toBe(1);
        // The stale bundle would have written the track's progress back to 0, undoing the completion; the fresh one keeps 1.
        expect(readWrittenCompletedThrough(stale)).toBe(0);
        expect(readWrittenCompletedThrough(fresh)).toBe(1);
    });
});

/** The track progress the bundle would write. */
function readWrittenCompletedThrough(bundle: ALInboundCommitBundle): number | undefined {
    return bundle.mutations.flatMap((mutation) => mutation.kind === 'set-delivery-progress' ? [mutation.value.completedThrough] : [])[0];
}
