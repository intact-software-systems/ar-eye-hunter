import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
    migrateLegacyRtcTopologyPublicationKeys,
    RtcTopologyPublicationRepository
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    invalidateLegacyScalarRtcTopologyAuthority
} from '@shared-server/rallar-system/repositories/RtcTopologyScalarAuthorityMigration.ts';
import {
    migrateLegacyRtcTopologySnapshotKeys,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { readApiV1Configuration } from '../src/configuration/read-api-v1-configuration.ts';
import { createApiV1DatabaseLifecycle } from '../src/db/api-v1-database-lifecycle.ts';
import {
    executeRtcPersistedStateMigration,
    parseRtcPersistedStateMigrationArgs,
    RTC_PERSISTED_STATE_MIGRATION_STEPS
} from '../src/operations/rtc-persisted-state-migration.ts';

const options = parseRtcPersistedStateMigrationArgs(Deno.args);

if (options.dryRun) {
    const result = await executeRtcPersistedStateMigration(
        options,
        RTC_PERSISTED_STATE_MIGRATION_STEPS.map((name) => ({
            name,
            run: () => Promise.reject(new Error('Dry-run migration action must not execute'))
        }))
    );
    console.log(JSON.stringify(result, null, 2));
}
else {
    // Argument acknowledgement is deliberately parsed before this connection is opened.
    const configuration = await readApiV1Configuration({
        environment: Deno.env,
        readTextFile: Deno.readTextFile,
        defaultsUrl: new URL('../resources/configuration/defaults-config.json', import.meta.url),
        profileUrls: {
            dev: new URL('../resources/configuration/dev-config.json', import.meta.url),
            prod: new URL('../resources/configuration/prod-config.json', import.meta.url),
            'prod-in-memory': new URL('../resources/configuration/prod-in-memory-config.json', import.meta.url)
        },
        staticClientsUrl: new URL('../resources/authorised-clients.json', import.meta.url)
    });
    const databaseLifecycle = await createApiV1DatabaseLifecycle({
        database: configuration.database,
        pgliteEvidence: {
            mode: 'disabled',
            pollIntervalMs: configuration.blackBox.pgliteEvidence.pollIntervalMs
        }
    });
    try {
        const runtime = new PSqlRuntimeStateRepository(databaseLifecycle.database);
        const snapshotRepository = new RtcTopologySnapshotRepository(runtime);
        const publicationRepository = new RtcTopologyPublicationRepository(runtime);
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
                            observedAtEpochMs
                        }
                    ).then(() => undefined)
            },
            {
                name: 'snapshot-keys',
                run: () =>
                    migrateLegacyRtcTopologySnapshotKeys(
                        snapshotRepository,
                        { oldWritersStopped, observedAtEpochMs }
                    )
            },
            {
                name: 'publication-keys',
                run: () =>
                    migrateLegacyRtcTopologyPublicationKeys(
                        publicationRepository,
                        { oldWritersStopped }
                    )
            }
        ]);
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        await databaseLifecycle.close();
    }
}
