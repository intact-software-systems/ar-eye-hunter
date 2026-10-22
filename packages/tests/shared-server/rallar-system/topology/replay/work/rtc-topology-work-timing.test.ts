import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';
import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttTopologyOutboxId
} from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { RtcRttRefinementGate } from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { EntityStatus, InMemoryQueueBox } from '@shared/mod.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import {
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement
} from '../../rtc-topology-test-fixtures.ts';

const NOW_EPOCH_MS = 50_000;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('RTC topology recompute timing line', () => {
    it('builds no event and reads no clock for it while timing is off, and emits one line while timing is on', async () => {
        const off = await runFirstRttRefresh({ timing: undefined, refinement: 'none' });
        const events: RallarTimingEvent[] = [];
        const on = await runFirstRttRefresh({ timing: (event) => events.push(event), refinement: 'none' });

        expect(off.timingClockReads).toBe(0);
        expect(on.timingClockReads).toBe(1);
        expect(events).toEqual([expect.objectContaining({
            component: 'rtc-topology-work',
            operation: 'recompute',
            groupId: 'group-1',
            details: expect.objectContaining({
                workKind: 'rtt-refresh',
                decision: 'accepted',
                outcome: 'write',
                reason: 'no-active-layout',
                overlayVersion: 1
            })
        })]);
        expect(events[0]?.details).not.toHaveProperty('layoutAgeMs', expect.anything());
    });

    it('records no line for a refresh the refinement gate skips, even while timing is on', async () => {
        const events: RallarTimingEvent[] = [];

        const skipped = await runFirstRttRefresh({ timing: (event) => events.push(event), refinement: 'refusing' });

        expect(skipped.timingClockReads).toBe(0);
        expect(events).toEqual([]);
    });
});

interface RunFirstRttRefreshInput {
    readonly timing: RallarTimingSink | undefined;
    readonly refinement: 'none' | 'refusing';
}

interface FirstRttRefreshRun {
    readonly timingClockReads: number;
}

async function runFirstRttRefresh(input: RunFirstRttRefreshInput): Promise<FirstRttRefreshRun> {
    const queue = new InMemoryQueueBox();
    const outboxQueueReader = new OutboxQueueReader(queue);
    const runtimeRepository = new FakeRuntimeStateRepository();
    const planning = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: () => undefined,
        readCurrentGroupSnapshot: async () => undefined,
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService({ now: () => NOW_EPOCH_MS }),
        topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
    }).planning;
    const handler = createRtcTopologyWorkHandler({
        nowEpochMs: () => NOW_EPOCH_MS,
        outboxQueueReader,
        database: createAppInboxTestDatabase(queue, { replace: async (entry) => entry }, { runtimeRepository }),
        topologyPlanning: planning,
        executionRepository: new RtcTopologyExecutionRepository(runtimeRepository, undefined, () => NOW_EPOCH_MS),
        ...(input.refinement === 'refusing' ? { rttRefinementService: createRefusingRefinementService() } : {}),
        timing: input.timing
    });
    const entry = await enqueueAndReserveRttRefresh(queue, outboxQueueReader);
    const timingClockReads: string[] = [];
    const readClock = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => {
        if (new Error().stack?.includes('recordRallarTiming')) {
            timingClockReads.push('recordRallarTiming');
        }
        return readClock();
    });
    await handler.onMessage(decodePersistedALMessage(entry.resource), entry);
    vi.restoreAllMocks();
    return { timingClockReads: timingClockReads.length };
}

async function enqueueAndReserveRttRefresh(queue: InMemoryQueueBox, outboxQueueReader: OutboxQueueReader) {
    const group = createRtcTopologyGroupSnapshot('group-1', createRtcTopologyMemberIds(6));
    const rtt = createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-1', sessionIdTo: 'peer-2', rttMs: 40, version: 1 });
    const receiptId = toRtcRttMutationReceiptId(rtt);
    const resourceId = toRtcRttTopologyOutboxId(receiptId, group.group, `sha256:${'a'.repeat(64)}`);
    await outboxQueueReader.outbox.enqueueIfAbsent(
        computeRtcTopologyOutboxInsert({
            commandId: resourceId,
            aggregateRef: group.group,
            acceptedCausalRevision: group.causalRevision,
            groupSnapshot: group,
            effectKind: 'rtc-topology-recompute',
            createdAtEpochMs: NOW_EPOCH_MS,
            expireAtEpochMs: 4_102_444_800_000,
            senderId: 'topology-service',
            resourceId,
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true,
            payloadKind: 'rtt-refresh',
            rtt,
            refinementObservationId: receiptId
        }).entry
    );
    const reserved = await queue.reserveEntries({
        typeIds: OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1
    });
    const entry = [...reserved.values()][0];
    if (!entry) {
        throw new Error('Expected reserved RTT refresh work');
    }
    return entry;
}

/** Equal predicted coordinates make every report's movement zero, so the gate never claims a refinement. */
function createRefusingRefinementService(): RtcRttRefinementService {
    const nodes = new Map<string, VivaldiNodeData>([
        ['peer-1', { id: 'peer-1', coords: [0], err: 0.1, rttMs: 0 }],
        ['peer-2', { id: 'peer-2', coords: [0], err: 0.1, rttMs: 0 }]
    ]);
    return new RtcRttRefinementService({
        gate: new RtcRttRefinementGate({ minIntervalMs: 0, vivaldiDeltaThresholdMs: 5 }),
        nowEpochMs: () => NOW_EPOCH_MS,
        observeRtt: () => true,
        readPredictedNodeData: () => nodes
    });
}
