import {
    describe,
    expect,
    it
} from 'vitest';

import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';

import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { computeRtcTopologyEntry } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import {
    cleanupTopologyApplicationRows,
    createPostgresSql,
    seedTopologyGroup,
    topologyGroupSnapshot
} from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres topology frozen work', () => {
    postgresIt(
        'freezes a connecting group\'s replacement: entry finished, snapshot and fingerprint untouched',
        async () => {
            const databaseUrl = process.env.DATABASE_URL;
            if (!databaseUrl) {
                throw new Error('DATABASE_URL is required when Postgres integration is enabled');
            }
            const applicationId = `topology-frozen-${crypto.randomUUID()}`;
            const groupRef = { applicationId, workspaceId: 'frozen', groupId: 'room' };
            const dialing = connectingSnapshot(topologyGroupSnapshot(groupRef), 1);
            const sql = await createPostgresSql(databaseUrl);
            const atEpochMs = Date.now();
            try {
                const harness = createFrozenWorkHarness(sql, () => atEpochMs);
                await seedTopologyGroup(sql, dialing);

                // Cycle 1: no stored row — establishment plans even while
                // connecting (freeze is replacement suppression only).
                await runTopologyWork({ harness: harness, groupSnapshot: dialing, name: 'first', atEpochMs: atEpochMs });
                const planned = await harness.snapshots.findSnapshot(groupRef);
                expect(planned?.state).toBe('active');
                const storedFingerprint = await harness.executionRepository
                    .readTopologyInputFingerprint(groupRef);
                expect(storedFingerprint).not.toBeNull();

                // Cycle 2: a later membership revision while still dialing —
                // the replacement freezes, the entry completes, and neither
                // the snapshot nor the staleness-latch fingerprint moves.
                // The enqueue-time snapshot carries the later revision; the
                // membership-delta read deliberately preserves it.
                const later = connectingSnapshot(topologyGroupSnapshot(groupRef), 2);
                await runTopologyWork({ harness: harness, groupSnapshot: later, name: 'second', atEpochMs: atEpochMs + 1 });

                const afterFreeze = await harness.snapshots.findSnapshot(groupRef);
                expect(afterFreeze).toEqual(planned);
                await expect(
                    harness.executionRepository.readTopologyInputFingerprint(groupRef)
                ).resolves.toBe(storedFingerprint);
                expect(harness.topologyService.readMetrics().topologyPlanFrozenCount).toBe(1);
            }
            finally {
                await cleanupTopologyApplicationRows(sql, applicationId);
                await sql.end();
            }
        },
        30_000
    );
});

interface FrozenWorkHarness {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly resources: ReturnType<typeof createPSqlResourceInboxRepository>;
    readonly snapshots: RtcTopologySnapshotRepository;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly topologyService: RallarRtcTopologyService;
}

function createFrozenWorkHarness(sql: PSqlSql, now: () => number): FrozenWorkHarness {
    const resources = createPSqlResourceInboxRepository(sql);
    const outboxQueueReader = new OutboxQueueReader(new PSqlQueueBox(resources));
    const runtime = createRtcTopologyOutboxPublisher({
        outboxQueueReader,
        senderId: 'topology-frozen-test',
        now
    });
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const groupStateRepository = createTestGroupStateRepository(
        runtimeRepository,
        new PSqlGroupStateEventRepository(sql)
    );
    const topologyService = new RallarRtcTopologyService({ now });
    const topologyManagement = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: async (ref) => await groupStateRepository.readSnapshot(ref),
        readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        topologyService,
        topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
    });
    const executionRepository = new RtcTopologyExecutionRepository(
        runtimeRepository,
        undefined,
        now
    );
    // The member seed mints presence-summary work this harness does not
    // exercise; a no-op consumer keeps the dequeue loop quiet.
    outboxQueueReader.onOutboxMessageDo(AppOutboxType.GROUP_PRESENCE_SUMMARY, {
        onMessage: async () => {}
    });
    outboxQueueReader.onOutboxMessageDo(
        runtime.workType,
        createRtcTopologyWorkHandler({
            runtime,
            database: sql,
            topologyPlanning: topologyManagement.planning,
            executionRepository,
            serviceId: 'topology-frozen-test'
        })
    );
    return {
        outboxQueueReader,
        resources,
        snapshots: new RtcTopologySnapshotRepository(runtimeRepository),
        executionRepository,
        topologyService
    };
}

async function runTopologyWork(input: RunTopologyWorkInput): Promise<void> {
    const { harness, groupSnapshot, name, atEpochMs } = input;
    const entry = computeRtcTopologyEntry({
        commandId: `${groupSnapshot.group.applicationId}-${name}`,
        aggregateRef: groupSnapshot.group,
        acceptedCausalRevision: groupSnapshot.causalRevision,
        groupSnapshot,
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
        origin: 'automatic',
        createdAtEpochMs: atEpochMs,
        expireAtEpochMs: atEpochMs + 60_000,
        senderId: 'topology-frozen-test',
        resourceId: `${groupSnapshot.group.applicationId}-${name}-topology`,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true
    });
    expect(await harness.resources.entries.writeIfAbsentOrMatch(entry)).toBe('inserted');
    await runUntilCompleted(harness, entry.key);
}

async function runUntilCompleted(harness: FrozenWorkHarness, key: Key): Promise<void> {
    for (let iteration = 0; iteration < 40; iteration += 1) {
        const target = await harness.resources.entries.findAnyByKey(key);
        if (target?.status === EntityStatus.COMPLETED) {
            return;
        }
        if (target?.status === EntityStatus.FAILED) {
            throw new Error(`Topology work failed: ${key.resourceId}`);
        }
        await harness.outboxQueueReader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience()
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Topology work did not complete: ${key.resourceId}`);
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(100, duration, duration, duration),
        1,
        1,
        1,
        1
    );
}

function connectingSnapshot(base: GroupSnapshot, groupRevision: number): GroupSnapshot {
    return {
        ...base,
        causalRevision: { ...base.causalRevision, groupRevision },
        group: {
            ...base.group,
            lifecycleState: 'connecting',
            snapshotVersion: groupRevision
        }
    };
}
interface RunTopologyWorkInput {
    readonly harness: FrozenWorkHarness;
    readonly groupSnapshot: GroupSnapshot;
    readonly name: string;
    readonly atEpochMs: number;
}
