import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';

import {
    createInboundTestMessage,
    createInboundTestOrderedDelivery
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
const RUN_ID = `al-inbound-delivery-completion-${crypto.randomUUID()}`;
const NAMESPACE = `inbound-delivery-completion-${RUN_ID}`;

describe('Postgres inbound delivery completion', () => {
    let completing: PostgresSql | undefined;
    let admitting: PostgresSql | undefined;

    beforeAll(async () => {
        if (process.env.RALLAR_POSTGRES_INTEGRATION === '1') {
            completing = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            admitting = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        }
    });

    afterAll(async () => {
        if (completing !== undefined && admitting !== undefined) {
            try {
                await deletePostgresRunRows(completing, RUN_ID);
                expect(await readPostgresRunRowCounts(completing, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await completing.end();
                await admitting.end();
            }
        }
    });

    // The backend writes each row conditionally on the version its in-write read saw, so an admission that refreshes
    // the track's expiry inside that round trip made the completion conflict and its work hand the message over again.
    postgresIt('completes a delivery whose first write lost its row version to an expiry refresh', async () => {
        const completingStore = createPostgresInboundAdmissionStore(completing!, NAMESPACE);
        const admittingStore = createPostgresInboundAdmissionStore(admitting!, NAMESPACE);
        const first = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
        const trackKey = toALOrderingTrackKey(first)!;
        await admitPostgresInboundTestMessage(completingStore, first);
        const original = (await readProgress(completingStore, first))!;
        const second = createInboundTestMessage({ msgId: 'message-2', seq: 2 });
        const later: ALMessage = { ...second, constraints: { expiresAtMs: original.expireAtTimestamp + 60_000 } };
        const begin = completing!.begin;
        const held = vi.spyOn(completing!, 'begin').mockImplementationOnce(async (write) => {
            await admitPostgresInboundTestMessage(admittingStore, later);
            return await begin(write);
        });
        onTestFinished(() => held.mockRestore());

        expect(await createInboundTestOrderedDelivery(completingStore).complete(first)).toBe('completed');

        const refreshed = (await readProgress(completingStore, first))!;
        expect(refreshed.expireAtTimestamp).toBeGreaterThan(original.expireAtTimestamp);
        expect(refreshed.completedThrough).toBe(1);
        expect(await completingStore.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() })).toBeUndefined();
    });
});

async function readProgress(store: ALInboundAdmissionStore, message: ALMessage) {
    const trackKey = toALOrderingTrackKey(message)!;
    const track = await store.readOrderingTrack({ trackKey, message: message.id, nowMs: Date.now() });
    return track.observations.deliveryProgress?.value;
}
