import { expect, vi, type it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts';
import { PSqlRtcTopologyReplayRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts';
import { readRtcTopologyDeliveryStreamLease } from '@shared-server/rallar-system/topology/replay/postgres/read-rtc-topology-delivery-stream-lease.ts';

const LIVE_LEASE_MS = 30_000;
const LAPSING_LEASE_MS = 1;
const HOUR_MS = 3_600_000;

export interface RtcTopologyDeliveryStreamLeaseStore {
    readonly sql: PSqlSql;
    close(): Promise<void>;
}

export interface RtcTopologyDeliveryStreamLeaseContractInput {
    readonly test: typeof it | typeof it.skip;
    readonly openStore: () => Promise<RtcTopologyDeliveryStreamLeaseStore>;
}

/** Whether a stream's lease is live, as the lease's renewal judges it, on PGlite and PostgreSQL alike. */
export function describeRtcTopologyDeliveryStreamLeaseContract(
    input: RtcTopologyDeliveryStreamLeaseContractInput
): void {
    input.test('reads a registered lease live and a lapsed, refused or unregistered one not live', async () => {
        await withStreams(input, async ({ sql, live, lapsed }) => {
            const streams = new PSqlRtcTopologyDeliveryRepository(sql);
            const never = crypto.randomUUID();

            expect(await readRtcTopologyDeliveryStreamLease(sql, live)).toEqual({ streamId: live, live: true });
            expect(await readRtcTopologyDeliveryStreamLease(sql, lapsed)).toEqual({ streamId: lapsed, live: false });
            expect(await streams.renewStreamLease({ streamId: lapsed, leaseDurationMs: LIVE_LEASE_MS })).toEqual({
                status: 'lease-lost'
            });
            expect(await readRtcTopologyDeliveryStreamLease(sql, lapsed)).toEqual({ streamId: lapsed, live: false });
            expect(await readRtcTopologyDeliveryStreamLease(sql, never)).toEqual({ streamId: never, live: false });
        });
    });

    input.test('keeps both answers once the lapsed empty stream is retired', async () => {
        await withStreams(input, async ({ sql, live, lapsed }) => {
            await new PSqlRtcTopologyReplayRepository(sql).retireEmptyStreams({ pageSize: 100 });

            const remaining = await sql<Array<{ stream_id: string; }>>`
                select stream_id::text from rtc_topology_delivery_stream
                where stream_id = any(${[live, lapsed]}::uuid[])
            `;
            expect(remaining.map((row) => row.stream_id)).toEqual([live]);
            expect((await readRtcTopologyDeliveryStreamLease(sql, lapsed)).live).toBe(false);
            expect((await readRtcTopologyDeliveryStreamLease(sql, live)).live).toBe(true);
        });
    });
}

/**
 * PGlite's database clock is the process clock it runs in, so only a separate server can tell a lease judged on the
 * process clock from one judged on the database's.
 */
export function describeRtcTopologyDeliveryStreamLeaseDatabaseClock(
    input: RtcTopologyDeliveryStreamLeaseContractInput
): void {
    input.test('judges the lease on the database clock, not the process clock', async () => {
        await withStreams(input, async ({ sql, live, lapsed }) => {
            const now = Date.now();
            const clock = vi.spyOn(Date, 'now');
            try {
                clock.mockReturnValue(now + HOUR_MS);
                expect((await readRtcTopologyDeliveryStreamLease(sql, live)).live).toBe(true);
                clock.mockReturnValue(now - HOUR_MS);
                expect((await readRtcTopologyDeliveryStreamLease(sql, lapsed)).live).toBe(false);
            }
            finally {
                clock.mockRestore();
            }
        });
    });
}

interface LeaseStreams {
    readonly sql: PSqlSql;
    readonly live: string;
    readonly lapsed: string;
}

async function withStreams(
    input: RtcTopologyDeliveryStreamLeaseContractInput,
    test: (streams: LeaseStreams) => Promise<void>
): Promise<void> {
    const store = await input.openStore();
    const live = crypto.randomUUID();
    const lapsed = crypto.randomUUID();
    try {
        const streams = new PSqlRtcTopologyDeliveryRepository(store.sql);
        expect((await streams.registerStream({ streamId: live, leaseDurationMs: LIVE_LEASE_MS })).status).toBe('registered');
        expect((await streams.registerStream({ streamId: lapsed, leaseDurationMs: LAPSING_LEASE_MS })).status).toBe(
            'registered'
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        await test({ sql: store.sql, live, lapsed });
    }
    finally {
        await store.sql`delete from rtc_topology_delivery_stream where stream_id = any(${[live, lapsed]}::uuid[])`;
        await store.close();
    }
}
