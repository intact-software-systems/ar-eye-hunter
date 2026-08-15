import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
// prettier-ignore
import { PSqlRuntimeStateRepository }
  from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  migrateLegacyRtcTopologySnapshotKeys,
  RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import {
  migrateLegacyRtcTopologyPublicationKeys,
  RtcTopologyPublicationRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
// prettier-ignore
import { migrateLegacyRtcRttMeasurementKeys }
  from '@shared-server/rallar-system/rtc-topology/persistence/\
migrate-legacy-rtc-rtt-measurement-keys.ts';
// prettier-ignore
import { migrateLegacyRtcRttRecomputeIntentDeliveryState }
  from '@shared-server/rallar-system/rtc-topology/persistence/\
migrate-legacy-rtc-rtt-recompute-intents.ts';
// prettier-ignore
import { RtcRttRepository }
  from '@shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository.ts';
import {
  invalidateLegacyScalarRtcTopologyAuthority,
} from '@shared-server/rallar-system/repositories/RtcTopologyScalarAuthorityMigration.ts';
import {
  executeRtcPersistedStateMigration,
  parseRtcPersistedStateMigrationArgs,
  RTC_PERSISTED_STATE_MIGRATION_STEPS,
} from '../src/operations/rtc-persisted-state-migration.ts';
import { type ApiV1Sql, createApiV1SqlClient } from '../src/db/db.ts';
import { readApiV1DatabaseBackendConfig } from '../src/db/database-config.ts';

const options = parseRtcPersistedStateMigrationArgs(Deno.args);

if (options.dryRun) {
  const result = await executeRtcPersistedStateMigration(
    options,
    RTC_PERSISTED_STATE_MIGRATION_STEPS.map((name) => ({
      name,
      run: () => Promise.reject(new Error('Dry-run migration action must not execute')),
    })),
  );
  console.log(JSON.stringify(result, null, 2));
} else {
  // Argument acknowledgement is deliberately parsed before this connection is opened.
  const sql = createApiV1SqlClient(readApiV1DatabaseBackendConfig());
  try {
    const runtime = new PSqlRuntimeStateRepository(sql as PSqlSql);
    const snapshotRepository = new RtcTopologySnapshotRepository(runtime);
    const publicationRepository = new RtcTopologyPublicationRepository(runtime);
    const rttRepository = new RtcRttRepository(runtime);
    const oldWritersStopped = options.oldWritersStopped;
    const observedAtEpochMs = Date.now();
    const scalarAuthorityMigrationId = 'api-v1-group-causal-tuple-v1';
    const result = await executeRtcPersistedStateMigration(options, [
      {
        name: 'topology-scalar-authority',
        run: () =>
          invalidateLegacyScalarRtcTopologyAuthority(
            runtime,
            {
              oldWritersStopped,
              migrationId: scalarAuthorityMigrationId,
              observedAtEpochMs,
            },
          ).then(() => undefined),
      },
      {
        name: 'snapshot-keys',
        run: () =>
          migrateLegacyRtcTopologySnapshotKeys(
            snapshotRepository,
            { oldWritersStopped, observedAtEpochMs },
          ),
      },
      {
        name: 'publication-keys',
        run: () =>
          migrateLegacyRtcTopologyPublicationKeys(
            publicationRepository,
            { oldWritersStopped },
          ),
      },
      {
        name: 'rtt-keys',
        run: () =>
          migrateLegacyRtcRttMeasurementKeys(
            rttRepository,
            { oldWritersStopped },
          ),
      },
      {
        name: 'intent-delivery',
        run: () =>
          migrateLegacyRtcRttRecomputeIntentDeliveryState(
            rttRepository,
            { oldWritersStopped },
          ),
      },
    ]);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeApiV1SqlClient(sql);
  }
}

async function closeApiV1SqlClient(sql: ApiV1Sql): Promise<void> {
  const closable = sql as unknown as Readonly<{
    close?: () => Promise<void>;
    end?: (options?: Readonly<{ timeout?: number }>) => Promise<void>;
  }>;
  if (closable.close) {
    await closable.close();
    return;
  }
  await closable.end?.({ timeout: 5 });
}
