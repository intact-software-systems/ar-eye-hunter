import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { RtcTopologyDeliveryLeaseLostError } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-stream-service.ts';
import { RtcTopologyDeliveryCorruptionError } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-validation.ts';
import { PSqlRtcTopologyReplayRepository } from '@shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts';
import { createPGliteSqlClient, type PGliteSql } from '../../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

const CONSUMER = '00000000-0000-4000-8000-000000000001';
const PUBLISHER_A = '00000000-0000-4000-8000-000000000002';
const PUBLISHER_B = '00000000-0000-4000-8000-000000000003';

describe('PSqlRtcTopologyReplayRepository', () => {
    it('atomically seeds a new consumer to every captured publisher HEAD', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await insertStream(sql, PUBLISHER_A, { headSequence: 2 });
            await insertStream(sql, PUBLISHER_B, { headSequence: 5, retainedFromSequence: 3 });

            const cursors = await repository.initializeConsumer({ consumerStreamId: CONSUMER });

            expect(cursors).toEqual([
                replayCursor(CONSUMER, 0, 1, 0),
                replayCursor(PUBLISHER_A, 2, 1, 2),
                replayCursor(PUBLISHER_B, 5, 3, 5)
            ]);
            expect(await readCursorRows(sql, CONSUMER)).toEqual([
                { publisher_stream_id: CONSUMER, last_processed_sequence: 0 },
                { publisher_stream_id: PUBLISHER_A, last_processed_sequence: 2 },
                { publisher_stream_id: PUBLISHER_B, last_processed_sequence: 5 }
            ]);
        });
    });

    it('discovers a later publisher at retained floor minus one without moving existing cursors', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await insertStream(sql, PUBLISHER_A, { headSequence: 2 });
            await repository.initializeConsumer({ consumerStreamId: CONSUMER });
            await insertStream(sql, PUBLISHER_B, { headSequence: 5, retainedFromSequence: 3 });

            const cursors = await repository.discoverPublishers({ consumerStreamId: CONSUMER });

            expect(cursors).toEqual([
                replayCursor(CONSUMER, 0, 1, 0),
                replayCursor(PUBLISHER_A, 2, 1, 2),
                replayCursor(PUBLISHER_B, 5, 3, 2)
            ]);
        });
    });

    it('captures one bounded contiguous page through the publisher HEAD', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await repository.initializeConsumer({ consumerStreamId: CONSUMER });
            await insertStream(sql, PUBLISHER_A, { headSequence: 3 });
            for (const sequence of [1, 2, 3]) {
                await insertEntry(sql, PUBLISHER_A, sequence);
            }
            await repository.discoverPublishers({ consumerStreamId: CONSUMER });

            const result = await repository.capturePage({
                consumerStreamId: CONSUMER,
                publisherStreamId: PUBLISHER_A,
                pageSize: 2
            });

            expect(result.status).toBe('page');
            if (result.status !== 'page') {
                throw new Error('Expected a replay page');
            }
            expect(result.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
            expect(result.capturedHeadSequence).toBe(3);
            expect(result.expectedCursorSequence).toBe(0);
            expect(result.hasMore).toBe(true);
            expect(result.databaseNowEpochMs).toBeGreaterThan(0);
        });
    });

    it('advances a cursor only from the exact expected predecessor', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await repository.initializeConsumer({ consumerStreamId: CONSUMER });

            await expect(
                repository.compareAndSetCursor({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: CONSUMER,
                    expectedSequence: 0,
                    nextSequence: 1
                })
            ).resolves.toEqual({ status: 'advanced' });
            await expect(
                repository.compareAndSetCursor({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: CONSUMER,
                    expectedSequence: 0,
                    nextSequence: 1
                })
            ).resolves.toEqual({ status: 'conflict', currentSequence: 1 });
            await expect(
                repository.compareAndSetCursor({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: PUBLISHER_A,
                    expectedSequence: 0,
                    nextSequence: 1
                })
            ).resolves.toEqual({ status: 'missing' });
        });
    });

    it('returns a typed gap when compaction moved beyond the next cursor sequence', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await repository.initializeConsumer({ consumerStreamId: CONSUMER });
            await insertStream(sql, PUBLISHER_A, { headSequence: 3, retainedFromSequence: 2 });
            for (const sequence of [2, 3]) {
                await insertEntry(sql, PUBLISHER_A, sequence);
            }
            await repository.discoverPublishers({ consumerStreamId: CONSUMER });
            await sql`
        update rtc_topology_replay_cursor
        set last_processed_sequence = 0
        where consumer_stream_id = ${CONSUMER}
          and publisher_stream_id = ${PUBLISHER_A}
      `;

            await expect(
                repository.capturePage({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: PUBLISHER_A,
                    pageSize: 100
                })
            ).resolves.toMatchObject({
                status: 'gap',
                cursorSequence: 0,
                retainedFromSequence: 2,
                capturedHeadSequence: 3
            });
        });
    });

    it('fails closed on cursor-ahead and unexplained physical-hole corruption', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await insertStream(sql, PUBLISHER_A, { headSequence: 2 });
            for (const sequence of [1, 2]) {
                await insertEntry(sql, PUBLISHER_A, sequence);
            }
            await repository.initializeConsumer({ consumerStreamId: CONSUMER });
            await sql`
        update rtc_topology_replay_cursor
        set last_processed_sequence = 3
        where consumer_stream_id = ${CONSUMER}
          and publisher_stream_id = ${PUBLISHER_A}
      `;
            await expect(
                repository.capturePage({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: PUBLISHER_A,
                    pageSize: 100
                })
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryCorruptionError);

            await sql`
        update rtc_topology_replay_cursor
        set last_processed_sequence = 0
        where consumer_stream_id = ${CONSUMER}
          and publisher_stream_id = ${PUBLISHER_A}
      `;
            await sql`
        delete from rtc_topology_delivery_log
        where publisher_stream_id = ${PUBLISHER_A}
          and sequence = 1
      `;
            await expect(
                repository.capturePage({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: PUBLISHER_A,
                    pageSize: 100
                })
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryCorruptionError);
        });
    });

    it('retires old consumer cursors before deleting only unreferenced empty streams', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0, leaseExpiresInMs: -90_000_000 });
            await insertStream(sql, PUBLISHER_A, { headSequence: 0, leaseExpiresInMs: -90_000_000 });
            await insertStream(sql, PUBLISHER_B, { headSequence: 0, leaseExpiresInMs: 30_000 });
            await sql`
        insert into rtc_topology_replay_cursor (
          consumer_stream_id,
          publisher_stream_id,
          last_processed_sequence
        ) values (
          ${CONSUMER},
          ${PUBLISHER_A},
          0
        )
      `;

            await expect(
                repository.retireExpiredConsumerCursors({ retentionMs: 86_400_000, pageSize: 100 })
            ).resolves.toEqual({ deletedCursorCount: 1 });
            await expect(repository.retireEmptyStreams({ pageSize: 100 })).resolves.toEqual({
                deletedStreamCount: 2
            });
            expect(await readStreamIds(sql)).toEqual([PUBLISHER_B]);
        });
    });

    it('releases only caught-up active cursors before final empty publisher retirement', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0 });
            await insertStream(sql, PUBLISHER_A, {
                headSequence: 3,
                retainedFromSequence: 4,
                leaseExpiresInMs: -1
            });
            await insertStream(sql, PUBLISHER_B, {
                headSequence: 3,
                retainedFromSequence: 4,
                leaseExpiresInMs: -1
            });
            await sql`
        insert into rtc_topology_replay_cursor (
          consumer_stream_id,
          publisher_stream_id,
          last_processed_sequence
        ) values
          (${CONSUMER}, ${PUBLISHER_A}, 3),
          (${CONSUMER}, ${PUBLISHER_B}, 2)
      `;

            await expect(repository.retireEmptyStreams({ pageSize: 100 })).resolves.toEqual({
                deletedStreamCount: 1
            });
            expect(await readStreamIds(sql)).toEqual([CONSUMER, PUBLISHER_B]);
            expect(await readCursorRows(sql, CONSUMER)).toEqual([
                { publisher_stream_id: PUBLISHER_B, last_processed_sequence: 2 }
            ]);
        });
    });

    it('reports an absent or expired consumer as typed lease loss on every owned operation', async () => {
        await withReplayRepository(async (sql, repository) => {
            await insertStream(sql, CONSUMER, { headSequence: 0, leaseExpiresInMs: -1 });
            await expect(
                repository.initializeConsumer({ consumerStreamId: CONSUMER })
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);

            await sql`
        update rtc_topology_delivery_stream
        set lease_expires_at = clock_timestamp() + interval '30 seconds'
        where stream_id = ${CONSUMER}
      `;
            await insertStream(sql, PUBLISHER_A, { headSequence: 0 });
            await repository.initializeConsumer({ consumerStreamId: CONSUMER });
            await sql`
        update rtc_topology_delivery_stream
        set lease_expires_at = clock_timestamp() - interval '1 second'
        where stream_id = ${CONSUMER}
      `;

            await expect(
                repository.discoverPublishers({ consumerStreamId: CONSUMER })
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
            await expect(
                repository.capturePage({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: PUBLISHER_A,
                    pageSize: 100
                })
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
            await expect(
                repository.compareAndSetCursor({
                    consumerStreamId: CONSUMER,
                    publisherStreamId: PUBLISHER_A,
                    expectedSequence: 0,
                    nextSequence: 1
                })
            ).rejects.toBeInstanceOf(RtcTopologyDeliveryLeaseLostError);
        });
    });
});

async function withReplayRepository(
    run: (sql: PGliteSql, repository: PSqlRtcTopologyReplayRepository) => Promise<void>
): Promise<void> {
    const raw = new PGlite();
    const sql = createPGliteSqlClient(raw);
    try {
        const schema = readFileSync(
            new URL('../../../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url),
            'utf8'
        );
        await sql.exec(schema);
        await run(sql, new PSqlRtcTopologyReplayRepository(sql));
    }
    finally {
        await sql.close();
    }
}

async function insertStream(
    sql: PGliteSql,
    streamId: string,
    input: Readonly<{
        headSequence: number;
        retainedFromSequence?: number;
        leaseExpiresInMs?: number;
    }>
): Promise<void> {
    const retainedFromSequence = input.retainedFromSequence ?? 1;
    const leaseExpiresInMs = input.leaseExpiresInMs ?? 30_000;
    await sql`
    insert into rtc_topology_delivery_stream (
      stream_id,
      head_sequence,
      retained_from_sequence,
      lease_expires_at
    ) values (
      ${streamId},
      ${input.headSequence},
      ${retainedFromSequence},
      clock_timestamp() + ${leaseExpiresInMs} * interval '1 millisecond'
    )
  `;
}

async function insertEntry(sql: PGliteSql, publisherStreamId: string, sequence: number) {
    await sql`
    insert into rtc_topology_delivery_log (
      publisher_stream_id,
      sequence,
      application_id,
      workspace_id,
      group_id,
      publication_id,
      outbox_topic_id,
      outbox_resource_id,
      outbox_context_id,
      retain_until
    ) values (
      ${publisherStreamId},
      ${sequence},
      'replay-app',
      'replay-workspace',
      'replay-group',
      ${`${publisherStreamId}:${sequence}`},
      'app-outbox.rtc-topology',
      ${`resource-${sequence}`},
      ${`context-${sequence}`},
      clock_timestamp() + interval '1 day'
    )
  `;
}

async function readCursorRows(sql: PGliteSql, consumerStreamId: string) {
    return await sql<Readonly<{ publisher_stream_id: string; last_processed_sequence: number; }>[]>`
    select
      publisher_stream_id::text,
      last_processed_sequence::double precision as last_processed_sequence
    from rtc_topology_replay_cursor
    where consumer_stream_id = ${consumerStreamId}
    order by publisher_stream_id
  `;
}

async function readStreamIds(sql: PGliteSql): Promise<string[]> {
    const rows = await sql<Readonly<{ stream_id: string; }>[]>`
    select stream_id::text
    from rtc_topology_delivery_stream
    order by stream_id
  `;
    return rows.map((row) => row.stream_id);
}

function replayCursor(
    publisherStreamId: string,
    headSequence: number,
    retainedFromSequence: number,
    lastProcessedSequence: number
) {
    return expect.objectContaining({
        consumerStreamId: CONSUMER,
        publisherStreamId,
        headSequence,
        retainedFromSequence,
        lastProcessedSequence
    });
}
