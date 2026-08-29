import {
    PSqlResourceInboxEntryRepository,
    ResourceInboxInvariantCorruptionError
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { describe, expect, it } from 'vitest';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateInsertGroupDescriptor } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-write-descriptors.ts';
import { IDEMPOTENT_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import { groupStateEventWorkspaceKey } from '@shared-server/rallar-system/state-events/postgres/group-state-event-workspace-key.ts';
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
        'rolls reset writes back when the final presence-summary outbox entry conflicts',
        async () => {
            const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
            const runtime = new PSqlRuntimeStateRepository(sql);
            const ref = uniqueResetGroupRef();
            const seedNamespace = `reset-rollback-seed-${crypto.randomUUID()}`;
            const read = resetRead(ref);
            const snapshot = resetLayoutSnapshot(ref);
            const computed = computeGroupMutation({
                command: { ...transitionCommand('resetGroupFormation'), aggregateRef: ref },
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
            const [outboxEntry] = computed.outboxEntries;
            if (outboxEntry === undefined || computed.idempotency === null) {
                throw new Error('Reset must produce an idempotency receipt and presence-summary outbox entry');
            }
            const mismatchingOutboxEntry = {
                ...outboxEntry,
                resource: `${outboxEntry.resource}mismatch`
            };

            try {
                await runtime.begin(async (transactionRuntime) => {
                    await transactionRuntime.executeGuardedBatch({
                        guard: groupStateInsertGroupDescriptor(read.group!.value),
                        effects: [{
                            effectId: 'reset-rollback-seed',
                            operation: 'insert',
                            namespace: seedNamespace,
                            key: 'seed',
                            value: 'seed',
                            expireAtTimestamp: FUTURE_MS
                        }]
                    });
                    await new RtcTopologySnapshotRepository(transactionRuntime).commitSnapshotGuard(snapshot, null);
                    await new RtcTopologySnapshotRepository(
                        transactionRuntime,
                        RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
                    ).commitSnapshotGuard(snapshot, null);
                });
                const planned = new RtcTopologySnapshotRepository(runtime);
                const accepted = new RtcTopologySnapshotRepository(
                    runtime,
                    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE
                );
                const outbox = new PSqlResourceInboxEntryRepository(sql);
                expect(await outbox.writeIfAbsentOrMatch(mismatchingOutboxEntry)).toBe('inserted');

                await expect(sql.begin(async (transaction) => await writeGroupMutation(transaction, computed)))
                    .rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);

                const group = await runtime.findEntry(
                    'group-state:groups',
                    groupStateGroupStorageKey(computed.guard.value)
                );
                expect(group?.revision).toBe(0);
                expect(group?.value).toBe(JSON.stringify(read.group!.value));
                expect(await planned.findSnapshot(snapshot.groupRef)).toEqual(snapshot);
                expect(await accepted.findSnapshot(snapshot.groupRef)).toEqual(snapshot);
                await expect(
                    runtime.findEntry(
                        IDEMPOTENT_NAMESPACE,
                        groupStateIdempotencyStorageKey(ref, computed.idempotency.requestId)
                    )
                ).resolves.toBeUndefined();
                await expect(new PSqlGroupStateEventRepository(sql).listGroupEvents(ref)).resolves.toEqual([]);
                expect(await outbox.findAnyByKey(outboxEntry.key)).toMatchObject({
                    key: mismatchingOutboxEntry.key,
                    resource: mismatchingOutboxEntry.resource,
                    typeId: mismatchingOutboxEntry.typeId,
                    status: mismatchingOutboxEntry.status,
                    audit: mismatchingOutboxEntry.audit
                });
            }
            finally {
                await sql`
                delete from runtime_state_store
                where (
                    store_namespace in ('group-state:groups', 'rtc-topology:snapshots', 'rtc-topology:accepted-snapshots')
                    and store_key = ${groupStateGroupStorageKey(ref)}
                ) or store_namespace = ${seedNamespace}
                   or (
                       store_namespace = ${IDEMPOTENT_NAMESPACE}
                       and store_key = ${groupStateIdempotencyStorageKey(ref, computed.idempotency?.requestId ?? '')}
                   )
            `;
                await sql`
                delete from group_state_events
                where application_id = ${ref.applicationId}
                  and workspace_key = ${groupStateEventWorkspaceKey(ref.workspaceId)}
                  and group_id = ${ref.groupId}
            `;
                await sql`
                delete from resource_inbox
                where fk_ext_bank_id = ${outboxEntry?.key.contextId ?? ''}
                  and ri_topic_id = ${outboxEntry?.key.topicId ?? ''}
                  and ri_resource_id = ${outboxEntry?.key.resourceId ?? ''}
            `;
                await sql.end();
            }
        }
    );
});

function resetLayoutSnapshot(ref: ReturnType<typeof uniqueResetGroupRef>): RallarOverlayTopologySnapshot {
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

function uniqueResetGroupRef() {
    return {
        ...groupRef('pure-room'),
        applicationId: `reset-rollback-${crypto.randomUUID()}`
    };
}

function resetRead(ref: ReturnType<typeof uniqueResetGroupRef>) {
    const initial = createGroupAuthorityRead({ lifecycleState: 'active' });
    const group = { ...initial.group!.value, ...ref };
    const actorMember = { ...initial.actorMember!, ...ref };
    return {
        ...initial,
        group: {
            entry: {
                ...initial.group!.entry,
                key: groupStateGroupStorageKey(ref),
                value: JSON.stringify(group)
            },
            value: group
        },
        actorMember,
        actorMemberEntry: {
            entry: {
                ...initial.actorMemberEntry!.entry,
                key: groupStateMemberStorageKey(actorMember),
                value: JSON.stringify(actorMember)
            },
            value: actorMember
        }
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
