import assert from 'node:assert/strict';

type MigrationModule = Readonly<{
  parseRtcPersistedStateMigrationArgs(args: readonly string[]): Readonly<{
    oldWritersStopped: true;
    dryRun: boolean;
  }>;
  executeRtcPersistedStateMigration(
    options: Readonly<{ oldWritersStopped: true; dryRun: boolean }>,
    actions: readonly Readonly<{ name: string; run(): Promise<void> }>[],
  ): Promise<Readonly<{ dryRun: boolean; completedSteps: readonly string[] }>>;
}>;

Deno.test('RTC persisted-state migration requires explicit stopped-writer acknowledgement', async () => {
  const migration = await loadMigrationModule();

  assert.throws(
    () => migration.parseRtcPersistedStateMigrationArgs([]),
    /--old-writers-stopped/,
  );
  assert.deepEqual(
    migration.parseRtcPersistedStateMigrationArgs([
      '--old-writers-stopped',
      '--dry-run',
    ]),
    { oldWritersStopped: true, dryRun: true },
  );
});

Deno.test('RTC persisted-state migration dry run reports safe order without writes', async () => {
  const migration = await loadMigrationModule();
  const calls: string[] = [];
  const actions = [
    'topology-scalar-authority',
    'snapshot-keys',
    'publication-keys',
    'rtt-keys',
    'intent-delivery',
  ]
    .map((name) => ({
      name,
      run: () => {
        calls.push(name);
        return Promise.resolve();
      },
    }));

  const result = await migration.executeRtcPersistedStateMigration(
    { oldWritersStopped: true, dryRun: true },
    actions,
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    dryRun: true,
    completedSteps: [
      'topology-scalar-authority',
      'snapshot-keys',
      'publication-keys',
      'rtt-keys',
      'intent-delivery',
    ],
  });
});

Deno.test('RTC persisted-state migration runs in order and stops after an error', async () => {
  const migration = await loadMigrationModule();
  const calls: string[] = [];
  const failure = new Error('publication migration failed');

  await assert.rejects(
    migration.executeRtcPersistedStateMigration(
      { oldWritersStopped: true, dryRun: false },
      [
        {
          name: 'topology-scalar-authority',
          run: () => {
            calls.push('topology-scalar-authority');
            return Promise.resolve();
          },
        },
        {
          name: 'snapshot-keys',
          run: () => {
            calls.push('snapshot-keys');
            return Promise.resolve();
          },
        },
        {
          name: 'publication-keys',
          run: () => {
            calls.push('publication-keys');
            return Promise.reject(failure);
          },
        },
        {
          name: 'rtt-keys',
          run: () => {
            calls.push('rtt-keys');
            return Promise.resolve();
          },
        },
      ],
    ),
    failure,
  );
  assert.deepEqual(calls, [
    'topology-scalar-authority',
    'snapshot-keys',
    'publication-keys',
  ]);
});

Deno.test('RTC migration operator task and runbook expose dry-run and cutover acknowledgement', async () => {
  const denoConfig = JSON.parse(
    await Deno.readTextFile(
      new URL('../../deno.json', import.meta.url),
    ),
  ) as { tasks?: Record<string, string> };
  assert.match(denoConfig.tasks?.['rtc:migrate-persisted-state'] ?? '', /scripts\/migrate/);
  const script = await Deno.readTextFile(
    new URL('../../scripts/migrate-rtc-persisted-state.ts', import.meta.url),
  );
  assert.match(script, /oldWritersStopped/);
  assert.match(script, /invalidateLegacyScalarRtcTopologyAuthority/);
  assert.match(script, /migrateLegacyRtcTopologySnapshotKeys/);
  assert.match(script, /migrateLegacyRtcTopologyPublicationKeys/);
  assert.match(script, /migrateLegacyRtcRttMeasurementKeys/);
  assert.match(script, /migrateLegacyRtcRttRecomputeIntentDeliveryState/);
  const readme = await Deno.readTextFile(new URL('../../README.md', import.meta.url));
  const middleware = await Deno.readTextFile(
    new URL('../../src/middleware.ts', import.meta.url),
  );
  assert.match(readme, /rtc:migrate-persisted-state/);
  assert.match(readme, /--old-writers-stopped/);
  assert.match(readme, /backup/i);
  assert.match(readme, /rollback/i);
  assert.match(readme, /durable recompute request/i);
  assert.match(readme, /restart/i);
  assert.match(middleware, /initRtcTopologyScalarRecomputeWorker/);
  assert.match(middleware, /writeRtcTopologyOutbox/);
  assert.match(middleware, /deriveRtcTopologyEntryResourceId/);
  assert.doesNotMatch(middleware, /enqueueForStateMutation/);
  assert.match(middleware, /group-absent-terminal/);
  assert.match(middleware, /registerMiddlewareBackgroundTask/);
});

async function loadMigrationModule(): Promise<MigrationModule> {
  const moduleUrl = new URL(
    '../../src/operations/rtc-persisted-state-migration.ts',
    import.meta.url,
  );
  try {
    return await import(moduleUrl.href) as MigrationModule;
  } catch (error) {
    throw new Error('RTC persisted-state migration operation is missing', {
      cause: error,
    });
  }
}
