import { describe, expect, it } from 'vitest';

import { PSqlRtcTopologyDeliveryRepository } from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-delivery-repository.ts';
import { PSqlRtcTopologyReplayRepository } from '@shared-server/postgres/rtc-topology/p-sql-rtc-topology-replay-repository.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { RtcTopologyDeliveryLogEntry } from '@shared-server/rallar-system/topology/replay/rtc-topology-delivery-contracts.ts';
import { RTC_TOPOLOGY_REPLAY_ANTI_ENTROPY_INTERVAL_MS } from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-policy.ts';
import {
  RtcTopologyReplayService,
  type RtcTopologyReplayServiceScheduler,
} from '@shared-server/rallar-system/topology/replay/rtc-topology-replay-service.ts';

import {
  createPostgresSql,
  type PostgresSql,
} from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres RTC topology replay consumer', () => {
  postgresIt(
    'lets passive live C poll and drain independent A/B streams without a notification wake',
    async () => {
      await withReplayDatabases(async ({ sqlA, sqlB, sqlC, streamIds }) => {
        const [streamA, streamB, streamC] = [
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
        ];
        streamIds.push(streamA, streamB, streamC);
        const publisherA = new PSqlRtcTopologyDeliveryRepository(sqlA);
        const publisherB = new PSqlRtcTopologyDeliveryRepository(sqlB);
        const publisherC = new PSqlRtcTopologyDeliveryRepository(sqlC);
        await Promise.all([
          registerStream(publisherA, streamA),
          registerStream(publisherB, streamB),
          registerStream(publisherC, streamC),
        ]);

        const scheduler = controlledPollScheduler();
        const handled: RtcTopologyDeliveryLogEntry[] = [];
        const replay = new RtcTopologyReplayService({
          consumerStreamId: streamC,
          repository: new PSqlRtcTopologyReplayRepository(sqlC),
          entryHandler: {
            handle: async (entry) => {
              handled.push(entry);
              return { status: 'delivered' };
            },
          },
          hydrateGap: async () => undefined,
          scheduler,
          onHealthFailure: (error) => {
            throw error;
          },
        });
        await replay.start();

        await Promise.all([
          append(publisherA, sqlA, streamA, 'publisher-a'),
          append(publisherB, sqlB, streamB, 'publisher-b'),
        ]);
        scheduler.poll();
        await replay.whenIdle();

        expect(handled.map((entry) => entry.publisherStreamId).sort()).toEqual(
          [streamA, streamB].sort(),
        );
        expect(await readConsumerCursors(sqlC, streamC)).toEqual(
          [
            { publisher_stream_id: streamA, last_processed_sequence: 1 },
            { publisher_stream_id: streamB, last_processed_sequence: 1 },
            { publisher_stream_id: streamC, last_processed_sequence: 0 },
          ].sort((left, right) =>
            left.publisher_stream_id.localeCompare(right.publisher_stream_id),
          ),
        );
        await replay.stop();
      });
    },
    60_000,
  );
});

interface ReplayDatabases {
  readonly sqlA: PostgresSql;
  readonly sqlB: PostgresSql;
  readonly sqlC: PostgresSql;
  readonly cleanup: PostgresSql;
  readonly streamIds: string[];
}

async function withReplayDatabases(
  run: (databases: ReplayDatabases) => Promise<void>,
): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  const [sqlA, sqlB, sqlC, cleanup] = await Promise.all([
    createPostgresSql(databaseUrl),
    createPostgresSql(databaseUrl),
    createPostgresSql(databaseUrl),
    createPostgresSql(databaseUrl),
  ]);
  const streamIds: string[] = [];
  try {
    await run({ sqlA, sqlB, sqlC, cleanup, streamIds });
  } finally {
    if (streamIds.length > 0) {
      await cleanup`
        delete from rtc_topology_replay_cursor
        where consumer_stream_id = any(${streamIds}::uuid[])
           or publisher_stream_id = any(${streamIds}::uuid[])
      `;
      await cleanup`
        delete from rtc_topology_delivery_log
        where publisher_stream_id = any(${streamIds}::uuid[])
      `;
      await cleanup`
        delete from rtc_topology_delivery_stream
        where stream_id = any(${streamIds}::uuid[])
      `;
    }
    await Promise.all([sqlA.end(), sqlB.end(), sqlC.end(), cleanup.end()]);
  }
}

async function registerStream(
  repository: PSqlRtcTopologyDeliveryRepository,
  streamId: string,
): Promise<void> {
  await expect(
    repository.registerStream({ streamId, leaseDurationMs: 60_000 }),
  ).resolves.toMatchObject({ status: 'registered' });
}

async function append(
  repository: PSqlRtcTopologyDeliveryRepository,
  sql: PSqlSql,
  streamId: string,
  name: string,
): Promise<void> {
  await expect(
    sql.begin(
      async (transaction) =>
        await repository.appendOrValidate(transaction, {
          publisherStreamId: streamId,
          groupRef: {
            applicationId: `replay-${name}`,
            workspaceId: 'postgres',
            groupId: 'room',
          },
          publicationId: `${name}-${crypto.randomUUID()}`,
          outboxKey: {
            topicId: 'rallar.overlay-topology.v1',
            resourceId: `${name}-outbox`,
            contextId: `${name}-room`,
          },
          retainUntilEpochMs: Date.now() + 60_000,
        }),
    ),
  ).resolves.toMatchObject({ status: 'appended', entry: { sequence: 1 } });
}

async function readConsumerCursors(sql: PSqlSql, consumerStreamId: string) {
  return await sql<
    Readonly<{
      publisher_stream_id: string;
      last_processed_sequence: number;
    }>[]
  >`
    select
      publisher_stream_id::text,
      last_processed_sequence::integer as last_processed_sequence
    from rtc_topology_replay_cursor
    where consumer_stream_id = ${consumerStreamId}
    order by publisher_stream_id
  `;
}

function controlledPollScheduler(): RtcTopologyReplayServiceScheduler & {
  poll(): void;
} {
  let poll: () => void = () => undefined;
  return {
    repeat: (task, intervalMs) => {
      if (intervalMs !== RTC_TOPOLOGY_REPLAY_ANTI_ENTROPY_INTERVAL_MS) {
        throw new Error(`Unexpected replay interval ${intervalMs}`);
      }
      poll = task;
      return () => {
        poll = () => undefined;
      };
    },
    yield: async () => undefined,
    poll: () => poll(),
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required when Postgres integration is enabled');
  }
  return databaseUrl;
}
