import { PGlite } from '@electric-sql/pglite';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { computeGroupConnectTriggerEntry } from '@shared-server/rallar-system/group-state/group-connect-trigger-outbox-entry.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { materializeGroupStateGuardedBatch, writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupConnectTriggerLatchRepository } from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { toAutomaticGroupConnectCommand } from '@shared-server/rallar-system/topology/replay/work/create-group-connect-trigger-work-handler.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { writeGroupConnectTriggerRequests } from '@shared-server/rallar-system/topology/replay/work/write-group-connect-trigger-requests.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';
import { createPGliteSqlClient } from '../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createGroupAuthorityFacts, createGroupAuthorityRead } from './group-mutation-test-runtime.ts';

describe.each(['memory', 'postgres'] as const)('connect trigger SQL atomicity (%s)', (backend) => {
    const sqlIt = backend === 'postgres' && process.env.RALLAR_POSTGRES_INTEGRATION !== '1' ? it.skip : it;

    sqlIt('rolls back a late outbox collision, commits the exact latch with group/plan, and rejects stale replay', async () => {
        await withConnectSql(backend, async (sql, applicationId) => {
            const { computed, runtime, identity } = await seedConnectWrite(sql, applicationId);
            const outbox = new PSqlResourceInboxEntryRepository(sql);
            const entry = computed.outboxEntries[0]!;
            await outbox.writeIfAbsentOrMatch({ ...entry, resource: 'collision' });
            const latches = new GroupConnectTriggerLatchRepository(runtime);
            await expect(sql.begin((tx) => writeGroupMutation(tx, computed))).rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });
            expect((await latches.read(identity))?.latch.state).toBe('awaiting-publication');
            const batch = materializeGroupStateGuardedBatch(computed);
            expect(JSON.parse((await runtime.findEntry(batch.guard.namespace, batch.guard.key))!.value).lifecycleState).toBe('planned');
            await sql`delete from resource_inbox where fk_ext_bank_id = ${entry.key.contextId} and ri_resource_id = ${entry.key.resourceId}`;
            await sql.begin((tx) => writeGroupMutation(tx, computed));
            expect((await latches.read(identity))?.latch.state).toBe('consumed');
            await expect(sql.begin((tx) => writeGroupMutation(tx, computed))).rejects.toThrow();
        });
    }, 30_000);

    sqlIt('production publication and unchanged handlers durably wake retry intent, with atomic rollback', async () => {
        await withConnectSql(backend, async (sql, applicationId) => {
            const h = createPublicationHandlerHarness(sql, applicationId);
            await h.runtime.publisher.enqueueForGroupSnapshot(h.group);
            const first = await reserveTopologyWork(h);
            const originalBegin = sql.begin.bind(sql);
            const fault = vi.spyOn(sql, 'begin').mockImplementation(async (write) => {
                return await originalBegin(async (tx) => {
                    await write(tx);
                    throw new Error('after publication before commit');
                });
            });
            await expect(h.handler.onMessage(JSON.parse(first.resource), first)).rejects.toThrow('after publication before commit');
            fault.mockRestore();
            expect(await h.snapshots.findSnapshot(h.group.group)).toBeUndefined();
            expect(await readPublicationWakes(sql, h.group)).toHaveLength(0);
            await h.handler.onMessage(JSON.parse(first.resource), first);
            const planned = await h.snapshots.findSnapshot(h.group.group);
            expect(planned?.state).toBe('active');
            expect(await readPublicationWakes(sql, h.group)).toHaveLength(1);
            await h.runtime.publisher.enqueueForRtt(h.group, { sessionIdFrom: 'a', sessionIdTo: 'b', rttMs: 1, version: 1, createdAtEpochMs: Date.now() }, 0);
            const unchanged = await reserveTopologyWork(h);
            await h.handler.onMessage(JSON.parse(unchanged.resource), unchanged);
            expect(await h.snapshots.findSnapshot(h.group.group)).toEqual(planned);
            expect(await readPublicationWakes(sql, h.group)).toHaveLength(2);
        });
    }, 30_000);

    sqlIt('publication and durable wake roll back together and replay is immutable', async () => {
        await withConnectSql(backend, async (sql, applicationId) => {
            const groupRef = { applicationId, workspaceId: 'ws', groupId: 'publication' };
            const work = computeGroupConnectTriggerEntry({
                work: { kind: 'publication', groupRef, wakeIdentity: 'source-publication-v1' },
                senderId: 'source-server',
                createdAtEpochMs: 1000,
                expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const key = groupStateGroupStorageKey(groupRef);
            const writePublication = async (tx: PSqlSql) => {
                await new PSqlRuntimeStateRepository(tx).insertIfAbsent('connect-test-publication', key, 'candidate-v1', NEVER_EXPIRE_AT_TIMESTAMP);
                await writeGroupConnectTriggerRequests(tx, [work]);
            };
            await expect(sql.begin(async (tx) => {
                await writePublication(tx);
                throw new Error('publication failure');
            })).rejects.toThrow('publication failure');
            const runtime = new PSqlRuntimeStateRepository(sql);
            expect(await runtime.findEntry('connect-test-publication', key)).toBeUndefined();
            expect(await sql`select ri_resource_id from resource_inbox where fk_ext_bank_id = ${work.key.contextId}`).toHaveLength(0);
            await sql.begin(writePublication);
            await sql.begin((tx) => writeGroupConnectTriggerRequests(tx, [work]));
            expect(await sql`select ri_resource_id from resource_inbox where fk_ext_bank_id = ${work.key.contextId}`).toHaveLength(1);
        });
    }, 30_000);
});

async function seedConnectWrite(sql: PSqlSql, applicationId: string) {
    const groupRef = { applicationId, workspaceId: 'ws', groupId: 'connect' };
    const identity = { groupRef, formationEpoch: 3, triggerGeneration: 'retry-plan' };
    const expectedLayout = { groupRevision: 4, presenceRevision: 0, version: 1, state: 'active' } as const;
    const planned = {
        groupRef,
        overlayId: toScopedOverlayId(groupRef),
        name: 'candidate',
        topology: 'tree' as const,
        degreeLimit: 2,
        activeSessionIds: [],
        nextHopsBySessionId: {},
        version: 1,
        state: 'active' as const,
        sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 0 },
        createdByClientId: 'server',
        createdAtEpochMs: 1000,
        updatedAtEpochMs: 1000
    };
    const base = createGroupAuthorityRead({ ...groupRef, lifecycleState: 'planned', formationEpoch: 3 });
    const group = { ...base.group!, entry: { ...base.group!.entry, key: groupStateGroupStorageKey(groupRef) } };
    const latch = { ...identity, state: 'awaiting-publication' } as const;
    const read = {
        ...base,
        group,
        actorMember: null,
        actorMemberEntry: null,
        plannedLayoutRow: { snapshot: planned, revision: 0 },
        connectTriggerLatch: { latch, revision: 0 }
    };
    const computed = computeGroupMutation({
        command: toAutomaticGroupConnectCommand(identity, expectedLayout),
        read,
        facts: { ...createGroupAuthorityFacts(), internalAuthority: 'formation-automation', authenticatedAuthority: null }
    });
    if (computed.outcome !== 'write') {
        throw new Error('Expected connect write');
    }
    const runtime = new PSqlRuntimeStateRepository(sql);
    const batch = materializeGroupStateGuardedBatch(computed);
    await runtime.upsert(batch.guard.namespace, batch.guard.key, JSON.stringify(group.value), NEVER_EXPIRE_AT_TIMESTAMP);
    for (const effect of batch.effects) {
        if (effect.effectId === 'planned-layout-fence' || effect.effectId === 'connect-trigger-latch') {
            await runtime.upsert(
                effect.namespace,
                effect.key,
                JSON.stringify(effect.effectId === 'planned-layout-fence' ? planned : latch),
                NEVER_EXPIRE_AT_TIMESTAMP
            );
        }
    }
    return { computed, runtime, identity };
}

async function withConnectSql(backend: 'memory' | 'postgres', run: (sql: PSqlSql, applicationId: string) => Promise<void>): Promise<void> {
    const applicationId = `connect-sql-${crypto.randomUUID()}`;
    if (backend === 'memory') {
        const sql = createPGliteSqlClient(new PGlite());
        try {
            await sql.exec(readFileSync(new URL('../../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url), 'utf8'));
            await run(sql, applicationId);
        }
        finally {
            await sql.close();
        }
        return;
    }
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    try {
        await run(sql, applicationId);
    }
    finally {
        const contexts = [
            { applicationId, workspaceId: 'ws', groupId: 'connect' },
            { applicationId, workspaceId: 'ws', groupId: 'publication' },
            { applicationId, workspaceId: 'workspace-1', groupId: 'pure-room' }
        ].map((ref) => toAppQueueKey({ contextId: groupStateGroupStorageKey(ref), topicId: 'unused', resourceId: 'unused' }).contextId);
        await sql`delete from runtime_state_store where store_key like ${`%${applicationId}%`} or store_value like ${`%${applicationId}%`}`;
        await sql`delete from resource_inbox where fk_ext_bank_id in ${sql(contexts)} or ri_resource like ${`%${applicationId}%`}`;
        await sql`delete from group_state_events where application_id = ${applicationId}`;
        expect(await sql`select ri_resource_id from resource_inbox where fk_ext_bank_id in ${sql(contexts)} or ri_resource like ${`%${applicationId}%`}`)
            .toHaveLength(0);
        await sql.end();
    }
}

function createPublicationHandlerHarness(sql: PSqlSql, applicationId: string) {
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const resources = createPSqlResourceInboxRepository(sql);
    const queue = new PSqlQueueBox(resources);
    const runtime = createRtcTopologyOutboxPublisher({ outboxQueueReader: new OutboxQueueReader(queue), senderId: 'publication-test' });
    const read = createGroupAuthorityRead({ applicationId, lifecycleState: 'planned', formationEpoch: 3 });
    const value = read.group!.value;
    const member = { ...read.actorMember!, applicationId, principalId: value.ownerPrincipalId, role: 'owner' as const };
    const group: GroupSnapshot = {
        group: value,
        causalRevision: { groupRevision: value.snapshotVersion, presenceRevision: 0 },
        members: [member],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
    const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
    const topology = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: async () => group,
        readCurrentGroupSnapshot: async () => group,
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService(),
        topologySnapshotRepository: snapshots
    });
    const handler = createRtcTopologyWorkHandler({
        runtime,
        database: sql,
        topologyPlanning: topology.planning,
        executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
        formationAutomation: {
            latches: new GroupConnectTriggerLatchRepository(runtimeRepository),
            readGroup: async () => group.group,
            readPlanned: async () => await snapshots.findSnapshot(group.group) ?? null,
            nowEpochMs: Date.now,
            submitCommand: async () => {
                throw new Error('Publication never submits directly');
            }
        }
    });
    return { resources, queue, runtime, group, snapshots, handler };
}

async function reserveTopologyWork(h: ReturnType<typeof createPublicationHandlerHarness>) {
    const entries = await Promise.all((await h.queue.getAllKeys()).map((key) => h.queue.getItem(key)));
    const entry = entries.find((candidate) => candidate?.status === EntityStatus.NEW && JSON.parse(candidate.resource).payload.typeId === h.runtime.workType);
    if (!entry) {
        throw new Error('Missing topology work');
    }
    const reserved = await h.resources.reservations.startProcessingEntity(entry);
    if (!reserved.right) {
        throw new Error('Topology reservation rejected');
    }
    return reserved.right;
}

async function readPublicationWakes(sql: PSqlSql, group: GroupSnapshot) {
    const key = toAppQueueKey({ contextId: groupStateGroupStorageKey(group.group), topicId: 'app-outbox.group-connect-trigger', resourceId: 'unused' });
    return await sql`select ri_resource_id from resource_inbox where fk_ext_bank_id = ${key.contextId} and ri_topic_id = ${key.topicId}`;
}
