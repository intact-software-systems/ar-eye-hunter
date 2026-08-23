import assert from 'node:assert/strict';

interface MigrationModule {
    parseRtcPersistedStateMigrationArgs(args: readonly string[]): Readonly<{
        oldWritersStopped: true;
        dryRun: boolean;
    }>;
    executeRtcPersistedStateMigration(
        options: Readonly<{ oldWritersStopped: true; dryRun: boolean; }>,
        actions: readonly Readonly<{ name: string; run(): Promise<void>; }>[]
    ): Promise<Readonly<{ dryRun: boolean; completedSteps: readonly string[]; }>>;
}

Deno.test('RTC persisted-state migration requires explicit stopped-writer acknowledgement', async () => {
    const migration = await loadMigrationModule();

    assert.throws(
        () => migration.parseRtcPersistedStateMigrationArgs([]),
        /--old-writers-stopped/
    );
    assert.deepEqual(
        migration.parseRtcPersistedStateMigrationArgs([
            '--old-writers-stopped',
            '--dry-run'
        ]),
        { oldWritersStopped: true, dryRun: true }
    );
});

Deno.test('RTC persisted-state migration dry run reports safe order without writes', async () => {
    const migration = await loadMigrationModule();
    const calls: string[] = [];
    const actions = [
        'topology-scalar-authority',
        'snapshot-keys',
        'publication-keys'
    ]
        .map((name) => ({
            name,
            run: () => {
                calls.push(name);
                return Promise.resolve();
            }
        }));

    const result = await migration.executeRtcPersistedStateMigration(
        { oldWritersStopped: true, dryRun: true },
        actions
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
        dryRun: true,
        completedSteps: [
            'topology-scalar-authority',
            'snapshot-keys',
            'publication-keys'
        ]
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
                    }
                },
                {
                    name: 'snapshot-keys',
                    run: () => {
                        calls.push('snapshot-keys');
                        return Promise.resolve();
                    }
                },
                {
                    name: 'publication-keys',
                    run: () => {
                        calls.push('publication-keys');
                        return Promise.reject(failure);
                    }
                }
            ]
        ),
        failure
    );
    assert.deepEqual(calls, [
        'topology-scalar-authority',
        'snapshot-keys',
        'publication-keys'
    ]);
});

Deno.test('RTC migration operator task and runbook expose dry-run and cutover acknowledgement', async () => {
    const denoConfig = JSON.parse(
        await Deno.readTextFile(
            new URL('../deno.json', import.meta.url)
        )
    ) as { tasks?: Record<string, string>; };
    assert.match(denoConfig.tasks?.['rtc:migrate-persisted-state'] ?? '', /src\/operations\/migrate/);
    const script = await Deno.readTextFile(
        new URL('../src/operations/migrate-rtc-persisted-state.ts', import.meta.url)
    );
    assert.match(script, /oldWritersStopped/);
    assert.match(script, /invalidateLegacyScalarRtcTopologyAuthority/);
    assert.match(script, /migrateLegacyRtcTopologySnapshotKeys/);
    assert.match(script, /migrateLegacyRtcTopologyPublicationKeys/);
    assert.doesNotMatch(script, /migrateLegacyRtcRtt/);
    const readme = await Deno.readTextFile(new URL('../README.md', import.meta.url));
    assert.match(readme, /rtc:migrate-persisted-state/);
    assert.match(readme, /--old-writers-stopped/);
    assert.match(readme, /backup/i);
    assert.match(readme, /rollback/i);
    assert.match(readme, /durable recompute request/i);
    assert.match(readme, /restart/i);
    const scalarWorkerRegistration = await Deno.readTextFile(
        new URL('../src/services/init-api-rtc-topology-scalar-recompute-worker.ts', import.meta.url)
    );
    assert.match(scalarWorkerRegistration, /initRtcTopologyScalarRecomputeWorker/);
    assert.match(scalarWorkerRegistration, /writeRtcTopologyOutbox/);
    assert.match(scalarWorkerRegistration, /deriveRtcTopologyEntryResourceId/);
    assert.doesNotMatch(scalarWorkerRegistration, /enqueueForStateMutation/);
    assert.match(scalarWorkerRegistration, /group-absent-terminal/);
});

async function loadMigrationModule(): Promise<MigrationModule> {
    const moduleUrl = new URL(
        '../src/operations/rtc-persisted-state-migration.ts',
        import.meta.url
    );
    try {
        return await import(moduleUrl.href) as MigrationModule;
    }
    catch (error) {
        throw new Error('RTC persisted-state migration operation is missing', {
            cause: error
        });
    }
}
