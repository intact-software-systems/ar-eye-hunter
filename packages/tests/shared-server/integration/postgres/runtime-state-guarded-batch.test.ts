import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { describe, expect, it } from 'vitest';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateInsertGroupDescriptor } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-write-descriptors.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    createGroupAuthorityFacts,
    createGroupAuthorityRead,
    groupRef,
    transitionCommand
} from '../../rallar-system/group-state/mutation/group-mutation-test-runtime.ts';

const POSTGRES_INTEGRATION_ENABLED = readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('2100-01-02T03:04:05.678Z');

type GlobalEnv = Readonly<{
    Deno?: Readonly<{
        env: Readonly<{
            get(key: string): string | undefined;
        }>;
    }>;
    process?: Readonly<{
        env?: Readonly<Record<string, string | undefined>>;
    }>;
}>;

describe('Postgres runtime-state guarded batches', () => {
    postgresIt(
        'executes a non-empty guarded batch through postgres.js',
        async () => {
            const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            const namespace = `guarded-batch-${crypto.randomUUID()}`;

            try {
                const result = await repository.begin(async (transactionRepository) => {
                    return await transactionRepository.executeGuardedBatch({
                        guard: {
                            operation: 'insert',
                            namespace,
                            key: 'guard',
                            value: 'guard-value',
                            expireAtTimestamp: FUTURE_MS
                        },
                        effects: [
                            {
                                effectId: 'insert-effect',
                                operation: 'insert',
                                namespace,
                                key: 'effect',
                                value: 'effect-value',
                                expireAtTimestamp: FUTURE_MS
                            }
                        ]
                    });
                });

                expect(result).toEqual({
                    guard: {
                        status: 'applied',
                        operation: 'insert',
                        namespace,
                        key: 'guard',
                        resultingRevision: 0
                    },
                    effects: [
                        {
                            status: 'applied',
                            effectId: 'insert-effect',
                            operation: 'insert',
                            namespace,
                            key: 'effect',
                            resultingRevision: 0
                        }
                    ]
                });
            }
            finally {
                await sql`
                delete from runtime_state_store
                where store_namespace = ${namespace}
            `;
                await sql.end();
            }
        }
    );

    postgresIt(
        'rolls reset group and planned-layout writes back when its accepted tombstone conflicts',
        async () => {
            const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
            const runtime = new PSqlRuntimeStateRepository(sql);
            const snapshot = resetLayoutSnapshot();
            const read = createGroupAuthorityRead({ lifecycleState: 'active' });
            const computed = computeGroupMutation({
                command: transitionCommand('resetGroupFormation'),
                read: {
                    ...read,
                    plannedLayoutRow: { snapshot, revision: 0 },
                    // Deliberately absent in Postgres: its update arrives after
                    // the group and planned effects and makes the batch conflict.
                    acceptedLayoutRow: { snapshot, revision: 0 }
                },
                facts: createGroupAuthorityFacts()
            });
            if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
                throw new Error('Reset must produce a group guarded write');
            }

            try {
                await runtime.executeGuardedBatch({
                    guard: groupStateInsertGroupDescriptor(read.group!.value),
                    effects: []
                });
                const planned = new RtcTopologySnapshotRepository(runtime);
                await planned.commitSnapshotGuard(snapshot, null);

                await expect(sql.begin(async (transaction) => await writeGroupMutation(transaction, computed)))
                    .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);

                const group = await runtime.findEntry(
                    'group-state:groups',
                    groupStateGroupStorageKey(computed.guard.value)
                );
                expect(group?.revision).toBe(0);
                expect(group?.value).toBe(JSON.stringify(read.group!.value));
                expect(await planned.findSnapshot(snapshot.groupRef)).toEqual(snapshot);
                const accepted = new RtcTopologySnapshotRepository(
                    runtime,
                    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
                );
                await expect(accepted.findSnapshot(snapshot.groupRef)).resolves.toBeUndefined();
            }
            finally {
                await sql`
                delete from runtime_state_store
                where store_namespace in ('group-state:groups', 'rtc-topology:snapshots', 'rtc-topology:accepted-snapshots')
                and store_key like ${'%pure-room%'}
            `;
                await sql.end();
            }
        }
    );
});

function resetLayoutSnapshot(): RallarOverlayTopologySnapshot {
    const ref = groupRef('pure-room');
    return {
        sourceGroupStateCausalRevision: { groupRevision: 0, presenceRevision: 0 },
        state: 'active',
        overlayId: toScopedOverlayId(ref),
        groupRef: ref,
        name: 'reset-layout',
        topology: 'tree',
        activeSessionIds: ['session-a'],
        nextHopsBySessionId: { 'session-a': [] },
        degreeLimit: 1,
        version: 1,
        createdByClientId: 'reset-test',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000
    };
}

function requireDatabaseUrl(): string {
    const databaseUrl = readEnv('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error(
            'DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1'
        );
    }
    return databaseUrl;
}

function readEnv(key: string): string | undefined {
    const globals = globalThis as GlobalEnv;
    return globals.Deno?.env.get(key) ?? globals.process?.env?.[key];
}
