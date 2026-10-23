import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    toStoredRtcTopologySnapshotRow
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/mod.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from '../../../app-inbox/test-support/app-inbox-test-database.ts';
import { createTopologySnapshot } from '../../rtc-topology-repository-test-fixtures.ts';
import { createRtcTopologyGroupSnapshot } from '../../rtc-topology-test-fixtures.ts';

describe('RTC topology queue conflict boundary', () => {
    it('leaves incomparable work retryable without writing or observing a commit', async () => {
        const base = createRtcTopologyGroupSnapshot('group-1', ['session-a', 'session-b']);
        const group = {
            ...base,
            causalRevision: { groupRevision: 1, presenceRevision: 2 },
            group: { ...base.group, snapshotVersion: 1, presenceVersion: 2 }
        };
        const snapshot = {
            ...createTopologySnapshot(toCanonicalGroupRef(group.group), 1),
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 1 }
        };
        const stored = toStoredRtcTopologySnapshotRow(snapshot);
        const runtime = new FakeRuntimeStateRepository();
        await runtime.upsert(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE, stored.key, stored.value, NEVER_EXPIRE_AT_TIMESTAMP);
        const before = [...runtime.data];
        const queue = new InMemoryQueueBox();
        const database = createAppInboxTestDatabase(queue, { replace: async (entry) => entry });
        const begin = vi.spyOn(database, 'begin');
        const observeCommittedTopology = vi.fn();
        const readTopologyPlanningAuthority = async () => ({
            group,
            config: resolveGroupTopologyConfig({}),
            kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
            rttReportingDegreeLimit: 5,
            rttMeasurements: [],
            rttReplanMinimumLayoutAgeMs: 15_000,
            replanning: 'auto' as const,
            nowEpochMs: 1_000
        });
        const handler = createRtcTopologyWorkHandler({
            nowEpochMs: () => 1_000,
            finishedRetentionMs: 3_600_000,
            outboxQueueReader: new OutboxQueueReader(queue),
            database,
            executionRepository: new RtcTopologyExecutionRepository(runtime),
            topologyPlanning: {
                readTopologyPlanningAuthority,
                readTopologyPlanningAuthorityIfPresent: readTopologyPlanningAuthority,
                readDurationNowMs: () => 0,
                observeCommittedTopology,
                recordTopologyPlanningObservation: vi.fn(),
                recordTopologyPublication: vi.fn(),
                recordTopologyPlanFrozen: vi.fn(),
                recordTopologyRebuildSkippedFingerprint: vi.fn()
            }
        });
        const queued = computeRtcTopologyOutboxInsert({
            commandId: 'conflict-command',
            aggregateRef: group.group,
            acceptedCausalRevision: group.causalRevision,
            groupSnapshot: group,
            effectKind: 'rtc-topology-recompute',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 10_000,
            senderId: 'topology-service',
            resourceId: 'conflict-work',
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: false,
            payloadKind: 'group-revision',
            origin: 'automatic'
        }).entry;
        const entry = { ...queued, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } };

        await expect(handler.onMessage(decodePersistedALMessage(entry.resource), entry)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(begin).not.toHaveBeenCalled();
        expect(observeCommittedTopology).not.toHaveBeenCalled();
        expect([...runtime.data]).toEqual(before);
    });
});
