// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    PSqlResourceInboxEntryRepository,
    ResourceInboxInvariantCorruptionError
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateInsertGroupDescriptor } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-write-descriptors.ts';
import { IDEMPOTENT_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import { groupStateEventWorkspaceKey } from '@shared-server/rallar-system/state-events/postgres/group-state-event-workspace-key.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import {
    RTC_TOPOLOGY_ACCEPTED_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { computeRuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch.ts';
import type { RuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
    createGroupAuthorityFacts,
    createGroupAuthorityRead,
    groupRef,
    transitionCommand
} from '../../rallar-system/group-state/mutation/group-mutation-test-runtime.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const POSTGRES_INTEGRATION_ENABLED = process.env.RALLAR_POSTGRES_INTEGRATION === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('2100-01-02T03:04:05.678Z');

describe('Postgres runtime-state guarded batches', () => {
    postgresIt(
        'executes a non-empty guarded batch through postgres.js',
        async () => {
            const namespace = `guarded-batch-${crypto.randomUUID()}`;
            const batch: RuntimeStateGuardedBatch = {
                guard: {
                    operation: 'insert',
                    namespace,
                    key: 'guard',
                    value: '{"label":"guard \\"quoted\\" — ø","path":"a\\\\b"}',
                    expireAtTimestamp: FUTURE_MS
                },
                effects: [{
                    effectId: 'insert-effect',
                    operation: 'insert',
                    namespace,
                    key: 'effect',
                    value: '{"label":"effect","nested":[1,true,null]}',
                    expireAtTimestamp: FUTURE_MS
                }]
            };

            const computed = computeRuntimeStateGuardedBatch(batch);
            const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            const repository = new PSqlRuntimeStateRepository(sql);
            try {
                const result = await repository.begin((transactionRepository) => transactionRepository.executeGuardedBatch(computed));

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
                expect(await repository.findEntry(namespace, 'guard')).toMatchObject({
                    value: '{"label":"guard \\"quoted\\" — ø","path":"a\\\\b"}',
                    expireAtTimestamp: FUTURE_MS,
                    revision: 0
                });
                expect(await repository.findEntry(namespace, 'effect')).toMatchObject({
                    value: '{"label":"effect","nested":[1,true,null]}',
                    expireAtTimestamp: FUTURE_MS,
                    revision: 0
                });
            }
            finally {
                try {
                    await sql`
                        delete from runtime_state_store
                        where store_namespace = ${namespace}
                    `;
                }
                finally {
                    await sql.end();
                }
            }
        }
    );

    postgresIt(
        'rolls reset writes back when the final presence-summary outbox entry conflicts',
        async () => {
            const ref = createResetGroupRef();
            const seedNamespace = `reset-rollback-seed-${crypto.randomUUID()}`;
            const read = createResetRead(ref);
            const snapshot = createResetLayoutSnapshot(ref);
            if (read.group === null) {
                throw new Error('Reset fixture requires a group');
            }
            const computed = computeGroupMutation({
                command: { ...transitionCommand('resetGroupFormation'), aggregateRef: ref },
                read: {
                    ...read,
                    plannedLayoutRow: { snapshot, revision: 0 },
                    acceptedLayoutRow: { snapshot, revision: 0 }
                },
                facts: createGroupAuthorityFacts()
            });
            if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
                throw new Error('Reset must produce a group guarded write');
            }
            const [outboxWrite] = computed.outboxWrites;
            if (computed.outboxWrites.length !== 1 || outboxWrite === undefined || computed.idempotency === null) {
                throw new Error('Reset must produce an idempotency receipt and presence-summary outbox entry');
            }
            const outboxEntry = outboxWrite.entry;
            const mismatchingOutboxEntry = {
                ...outboxEntry,
                resource: `${outboxEntry.resource}mismatch`
            };
            const seedBatch: RuntimeStateGuardedBatch = {
                guard: groupStateInsertGroupDescriptor(read.group.value),
                effects: [{
                    effectId: 'reset-rollback-seed',
                    operation: 'insert',
                    namespace: seedNamespace,
                    key: 'seed',
                    value: 'seed',
                    expireAtTimestamp: FUTURE_MS
                }]
            };
            const computedSeed = computeRuntimeStateGuardedBatch(seedBatch);
            const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            const runtime = new PSqlRuntimeStateRepository(sql);

            try {
                await runtime.begin(async (transactionRuntime) => {
                    await transactionRuntime.executeGuardedBatch(computedSeed);
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

                await expect(sql.begin((transaction) => writeGroupMutation(transaction, computed)))
                    .rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);

                const group = await runtime.findEntry(
                    'group-state:groups',
                    groupStateGroupStorageKey(computed.guard.value)
                );
                expect(group?.revision).toBe(0);
                expect(group?.value).toBe(JSON.stringify(read.group.value));
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
                try {
                    await sql`
                        delete from runtime_state_store
                        where (
                            store_namespace in ('group-state:groups', 'rtc-topology:snapshots', 'rtc-topology:accepted-snapshots')
                            and store_key = ${groupStateGroupStorageKey(ref)}
                        ) or store_namespace = ${seedNamespace}
                           or (
                               store_namespace = ${IDEMPOTENT_NAMESPACE}
                               and store_key = ${groupStateIdempotencyStorageKey(ref, computed.idempotency.requestId)}
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
                        where fk_ext_bank_id = ${outboxEntry.key.contextId}
                          and ri_topic_id = ${outboxEntry.key.topicId}
                          and ri_resource_id = ${outboxEntry.key.resourceId}
                    `;
                }
                finally {
                    await sql.end();
                }
            }
        }
    );
});

function createResetLayoutSnapshot(ref: GroupRef): RallarOverlayTopologySnapshot {
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

function createResetGroupRef(): GroupRef {
    return {
        ...groupRef('pure-room'),
        applicationId: `reset-rollback-${crypto.randomUUID()}`
    };
}

function createResetRead(ref: GroupRef): GroupMutationRead {
    const initial = createGroupAuthorityRead({ lifecycleState: 'active' });
    if (initial.group === null || initial.actorMember === null || initial.actorMemberEntry === null) {
        throw new Error('Reset fixture requires a group and actor member');
    }
    const group = { ...initial.group.value, ...ref };
    const actorMember = { ...initial.actorMember, ...ref };
    return {
        ...initial,
        group: {
            entry: {
                ...initial.group.entry,
                key: groupStateGroupStorageKey(ref),
                value: JSON.stringify(group)
            },
            value: group
        },
        actorMember,
        actorMemberEntry: {
            entry: {
                ...initial.actorMemberEntry.entry,
                key: groupStateMemberStorageKey(actorMember),
                value: JSON.stringify(actorMember)
            },
            value: actorMember
        }
    };
}
