import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttTopologyOutboxId
} from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import {
    cleanupTopologyApplicationRows,
    createPostgresSql
} from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';
import {
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement
} from '../../rallar-system/topology/rtc-topology-test-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const MINIMUM_LAYOUT_AGE_MS = 15_000;

describe('Postgres RTT replan hold', () => {
    postgresIt(
        'holds an RTT-only replan of a young stored layout and promotes it once the layout reaches the minimum age',
        async () => {
            const databaseUrl = process.env.DATABASE_URL;
            if (!databaseUrl) {
                throw new Error('DATABASE_URL is required when Postgres integration is enabled');
            }
            const applicationId = `topology-rtt-hold-${crypto.randomUUID()}`;
            const group = toApplicationGroup(
                createRtcTopologyGroupSnapshot('room', createRtcTopologyMemberIds(6)),
                applicationId
            );
            const sql = await createPostgresSql(databaseUrl);
            const acceptedAtEpochMs = Date.now();
            try {
                const harness = createHoldHarness(sql, acceptedAtEpochMs);

                // Without measurements the first refresh plans the no-RTT tree.
                await runRttRefresh(harness, group, 1);
                const accepted = await harness.snapshots.findSnapshot(group.group);
                const acceptedFingerprint = await harness.executionRepository.readTopologyInputFingerprint(group.group);
                expect(accepted?.updatedAtEpochMs).toBe(acceptedAtEpochMs);

                // Measurements that make every accepted edge slow would rebuild the tree.
                harness.setRttMeasurements(toSlowEdgeMeasurements(accepted?.nextHopsBySessionId ?? {}));
                harness.setNowEpochMs(acceptedAtEpochMs + 500);
                await runRttRefresh(harness, group, 2);
                await expect(harness.snapshots.findSnapshot(group.group)).resolves.toEqual(accepted);
                await expect(harness.executionRepository.readTopologyInputFingerprint(group.group))
                    .resolves.toBe(acceptedFingerprint);

                harness.setNowEpochMs(acceptedAtEpochMs + MINIMUM_LAYOUT_AGE_MS);
                await runRttRefresh(harness, group, 3);
                const promoted = await harness.snapshots.findSnapshot(group.group);
                expect(promoted?.version).toBe((accepted?.version ?? 0) + 1);
                expect(promoted?.nextHopsBySessionId).not.toEqual(accepted?.nextHopsBySessionId);
            }
            finally {
                await cleanupTopologyApplicationRows(sql, applicationId);
                await sql.end();
            }
        },
        60_000
    );
});

interface HoldHarness {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly resources: PSqlResourceInboxRepository;
    readonly snapshots: RtcTopologySnapshotRepository;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly readNowEpochMs: () => number;
    readonly setNowEpochMs: (nowEpochMs: number) => void;
    readonly setRttMeasurements: (measurements: readonly RttMeasurementInfo[]) => void;
}

/** The store holds no group row, so every refresh plans from the snapshot its work carries. */
function createHoldHarness(sql: PSqlSql, startEpochMs: number): HoldHarness {
    let nowEpochMs = startEpochMs;
    let rttMeasurements: readonly RttMeasurementInfo[] = [];
    const now = () => nowEpochMs;
    const resources = createPSqlResourceInboxRepository(sql, () => new Date(now()));
    const outboxQueueReader = new OutboxQueueReader(new PSqlQueueBox(resources, Temporal.Now.instant));
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const topologyManagement = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: async () => undefined,
        readCurrentGroupSnapshot: async () => undefined,
        readRttMeasurements: () => rttMeasurements,
        topologyService: new RallarRtcTopologyService({ now, rttReplanMinimumLayoutAgeMs: MINIMUM_LAYOUT_AGE_MS }),
        topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
    });
    const executionRepository = new RtcTopologyExecutionRepository(runtimeRepository, undefined, now);
    outboxQueueReader.onOutboxMessageDo(
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        createRtcTopologyWorkHandler({
            nowEpochMs: now,
            outboxQueueReader,
            database: sql,
            topologyPlanning: topologyManagement.planning,
            executionRepository,
            serviceId: 'topology-rtt-hold-test'
        })
    );
    return {
        outboxQueueReader,
        resources,
        snapshots: new RtcTopologySnapshotRepository(runtimeRepository),
        executionRepository,
        readNowEpochMs: now,
        setNowEpochMs: (next) => {
            nowEpochMs = next;
        },
        setRttMeasurements: (next) => {
            rttMeasurements = next;
        }
    };
}

async function runRttRefresh(harness: HoldHarness, group: GroupSnapshot, version: number): Promise<void> {
    const rtt = createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-1', sessionIdTo: 'peer-2', rttMs: 40, version });
    const receiptId = toRtcRttMutationReceiptId(rtt);
    const resourceId = toRtcRttTopologyOutboxId(receiptId, group.group, `sha256:${'a'.repeat(64)}`);
    const atEpochMs = harness.readNowEpochMs();
    const entry = computeRtcTopologyOutboxInsert({
        commandId: resourceId,
        aggregateRef: group.group,
        acceptedCausalRevision: group.causalRevision,
        groupSnapshot: group,
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'rtt-refresh',
        rtt,
        refinementObservationId: receiptId,
        createdAtEpochMs: atEpochMs,
        expireAtEpochMs: atEpochMs + 60_000,
        senderId: 'topology-rtt-hold-test',
        resourceId,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true
    }).entry;
    expect(await harness.resources.entries.writeIfAbsentOrMatch(entry)).toBe('inserted');
    await runUntilCompleted(harness, entry.key);
}

async function runUntilCompleted(harness: HoldHarness, key: Key): Promise<void> {
    for (let iteration = 0; iteration < 40; iteration += 1) {
        const target = await harness.resources.entries.findAnyByKey(key);
        if (target?.status === EntityStatus.COMPLETED) {
            return;
        }
        if (target?.status === EntityStatus.FAILED) {
            throw new Error(`Topology work failed: ${key.resourceId}`);
        }
        await harness.outboxQueueReader.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createResilience());
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Topology work did not complete: ${key.resourceId}`);
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(100, duration, duration, duration));
}

function toSlowEdgeMeasurements(nextHopsBySessionId: Readonly<Record<string, readonly string[]>>): readonly RttMeasurementInfo[] {
    const memberSessionIds = Object.keys(nextHopsBySessionId).sort();
    return memberSessionIds.flatMap((from, fromIndex) =>
        memberSessionIds.slice(fromIndex + 1).map((to, toIndex) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: nextHopsBySessionId[from]?.includes(to) ? 200 : 10,
                version: 100 + fromIndex * memberSessionIds.length + toIndex
            })
        )
    );
}

function toApplicationGroup(group: GroupSnapshot, applicationId: string): GroupSnapshot {
    return {
        ...group,
        group: { ...group.group, applicationId },
        members: group.members.map((member) => ({ ...member, applicationId })),
        activeSessions: group.activeSessions.map((session) => ({ ...session, applicationId }))
    };
}
