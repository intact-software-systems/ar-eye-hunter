import type { VivaldiNodeData } from '@shared-graph/graph/vivaldi.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { toRtcRttMutationReceiptId, toRtcRttTopologyOutboxId } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { RtcRttRefinementGate } from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-gate.ts';
import { RtcRttRefinementService } from '@shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import {
    createRtcTopologyOutboxPublisher,
    type RtcTopologyGroupRevisionWork,
    type RtcTopologyRttRefreshWork
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { readRtcTopologyWorkEnvelope } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { AuditStamp, GroupPresenceSummary, GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { EntityStatus, InMemoryQueueBox, type ALMessage } from '@shared/mod.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createTestGroup } from '../../../../create-test-group.ts';
import { createAppInboxTestDatabase } from '../../app-inbox/test-support/app-inbox-test-database.ts';

interface StoredRtcTopologyEnvelope {
    readonly resourceId: string;
    readonly data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;
}

interface EnqueueAndReserveRttInput {
    readonly queue: InMemoryQueueBox;
    readonly runtime: ReturnType<typeof createRtcTopologyOutboxPublisher>;
    readonly group: GroupSnapshot;
    readonly version: number;
}
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('RTC topology APP_OUTBOX work', () => {
    it('keeps each committed group revision as an immutable queue entry', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            senderId: 'server-a',
            now: () => 100
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);

        expect(await runtime.publisher.enqueueForGroupSnapshot(revision1)).toBeUndefined();
        await runtime.publisher.enqueueForGroupSnapshot(revision2);

        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => readEnvelope(entry).resourceId).sort()).toEqual([
            expect.stringContaining('group-revision:group=1;presence=0'),
            expect.stringContaining('group-revision:group=2;presence=0')
        ]);
        expect(entries.map(readWork)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'group-revision',
                    sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 0 },
                    groupSnapshot: revision1,
                    requestedAtEpochMs: 100
                }),
                expect.objectContaining({
                    kind: 'group-revision',
                    sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 0 },
                    groupSnapshot: revision2,
                    requestedAtEpochMs: 100
                })
            ])
        );
    });

    it('returns the durable winner revision for a mutation-stable resource id', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            senderId: 'server-a',
            now: () => 100
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);
        const deliveryId = 'state-mutation-1:rtc-topology-recompute:snapshot';

        const first = await runtime.publisher.enqueueForStateMutation(revision1, deliveryId);
        const duplicate = await runtime.publisher.enqueueForStateMutation(revision2, deliveryId);

        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(1);
        expect(readWork(entries[0]!)).toMatchObject({
            sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 0 },
            groupSnapshot: revision1
        });
        expect(first).toEqual({ effectiveCausalRevision: { groupRevision: 1, presenceRevision: 0 } });
        expect(duplicate).toEqual({ effectiveCausalRevision: { groupRevision: 1, presenceRevision: 0 } });
    });

    it('rejects equal-causal queued and finder authority with different content', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue)
        });
        const queuedGroup = createGroupSnapshotWithCausalRevision(7, 6);
        const corruptFinderGroup: GroupSnapshot = {
            ...queuedGroup,
            group: {
                ...queuedGroup.group,
                displayName: 'equal tuple but different finder authority'
            }
        };
        await runtime.publisher.enqueueForGroupSnapshot(queuedGroup);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: () => corruptFinderGroup,
            readCurrentGroupSnapshot: async () => corruptFinderGroup,
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
        });

        await expect(handler.onMessage(JSON.parse(entry!.resource), entry!)).rejects.toMatchObject({
            name: 'StateSnapshotRevisionConflictError'
        });
    });

    it('rejects incomparable queued and finder authority after a lower-bound cache miss', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue)
        });
        const queuedGroup = createGroupSnapshotWithCausalRevision(2, 1);
        const incomparableFinderGroup = createGroupSnapshotWithCausalRevision(1, 2);
        await runtime.publisher.enqueueForGroupSnapshot(queuedGroup);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const authoritySelections: Array<GroupStateCausalRevision | undefined> = [];
        const findGroupSnapshotByRef = (
            _groupRef: GroupRef,
            options?: Readonly<{
                minCausalRevision?: GroupStateCausalRevision;
            }>
        ) => {
            authoritySelections.push(options?.minCausalRevision);
            return options?.minCausalRevision ? undefined : incomparableFinderGroup;
        };
        const topologyManagement = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef,
            readCurrentGroupSnapshot: async (ref, knownGroup) =>
                await findGroupSnapshotByRef(ref, {
                    minCausalRevision: knownGroup?.causalRevision
                }) ?? await findGroupSnapshotByRef(ref),
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
        });

        await expect(handler.onMessage(JSON.parse(entry!.resource), entry!)).rejects.toMatchObject({
            name: 'GroupStateSnapshotIncomparableError'
        });
        expect(authoritySelections).toEqual([queuedGroup.causalRevision, undefined]);
    });

    it('prefers durable group authority when cache state masks an incomparable tuple', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue)
        });
        const queuedGroup = createGroupSnapshotWithCausalRevision(2, 1);
        const durableGroup = createGroupSnapshotWithCausalRevision(1, 2);
        await runtime.publisher.enqueueForGroupSnapshot(queuedGroup);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupStateRepository = createTestGroupStateRepository(runtimeRepository);
        await groupStateRepository.putGroup(durableGroup.group);
        await Promise.all(durableGroup.members.map((member) => groupStateRepository.putMember(member)));
        const presenceSummary: GroupPresenceSummary = {
            applicationId: durableGroup.group.applicationId,
            workspaceId: durableGroup.group.workspaceId,
            groupId: durableGroup.group.groupId,
            causalRevision: durableGroup.causalRevision,
            activePrincipalIds: [],
            activeSessionIds: [],
            activeSessions: [],
            activePrincipalCount: 0,
            activeSessionCount: 0,
            computedAtEpochMs: 10
        };
        expect(await groupStateRepository.insertPresenceSummary(presenceSummary)).toMatchObject({
            status: 'applied'
        });
        const topologyManagement = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: () => {
                throw new Error('Durable authority must resolve before consulting process cache state');
            },
            readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
        });

        await expect(handler.onMessage(JSON.parse(entry!.resource), entry!)).rejects.toMatchObject({
            name: 'GroupStateSnapshotIncomparableError'
        });
    });

    it.each(
        [
            'missing-causal-revision',
            'wrong-sender',
            'wrong-type',
            'invalid-forwarding',
            'invalid-qos-options',
            'invalid-diagnostics',
            'missing-target-workspace',
            'missing-room-broadcast-group-ref'
        ] as const
    )('rejects %s work before reading mutable authority', async (defect) => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue)
        });
        const group = createGroupSnapshot(4);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const message = readStoredALMessage(entry);
        let corruptMessage: ALMessage;
        if (defect === 'wrong-sender') {
            corruptMessage = {
                ...message,
                id: { ...message.id, senderId: 'wrong-server' }
            };
        }
        else if (defect === 'wrong-type') {
            corruptMessage = {
                ...message,
                payload: { ...message.payload, typeId: 'wrong-work-type' }
            };
        }
        else if (defect === 'invalid-forwarding') {
            corruptMessage = JSON.parse(
                JSON.stringify({
                    ...message,
                    forwarding: { fanoutLimit: 0 }
                })
            );
        }
        else if (defect === 'invalid-qos-options') {
            corruptMessage = JSON.parse(
                JSON.stringify({
                    ...message,
                    qos: {
                        retry: {
                            algo: 'exp-backoff',
                            opts: { maxAttempts: -1 }
                        }
                    }
                })
            );
        }
        else if (defect === 'invalid-diagnostics') {
            corruptMessage = JSON.parse(
                JSON.stringify({
                    ...message,
                    diagnostics: { visitedPeerIds: [''] }
                })
            );
        }
        else if (defect === 'missing-target-workspace') {
            corruptMessage = JSON.parse(
                JSON.stringify({
                    ...message,
                    targets: {
                        mode: 'multicast',
                        groupRef: {
                            applicationId: group.group.applicationId,
                            groupId: group.group.groupId
                        }
                    }
                })
            );
        }
        else if (defect === 'missing-room-broadcast-group-ref') {
            corruptMessage = JSON.parse(
                JSON.stringify({
                    ...message,
                    targets: {
                        mode: 'broadcast',
                        scope: 'room'
                    }
                })
            );
        }
        else {
            const envelope = readJsonObject(message.payload.resource, 'topology work envelope');
            const data = requireJsonObject(envelope.data, 'topology work data');
            const groupSnapshot = requireJsonObject(
                data.groupSnapshot,
                'topology work group snapshot'
            );
            const { causalRevision: _causalRevision, ...snapshotWithoutCausalRevision } = groupSnapshot;
            corruptMessage = {
                ...message,
                payload: {
                    ...message.payload,
                    resource: JSON.stringify({
                        ...envelope,
                        data: {
                            ...data,
                            groupSnapshot: snapshotWithoutCausalRevision
                        }
                    })
                }
            };
        }
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: () => {
                throw new Error('Malformed topology work must not read mutable authority');
            },
            readCurrentGroupSnapshot: async () => {
                throw new Error('Malformed topology work must not read mutable authority');
            },
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
        });

        await expect(handler.onMessage(corruptMessage, entry)).rejects.toBeInstanceOf(TypeError);
    });

    it('rejects retired RTT group-revision work before reading mutable authority', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue)
        });
        const group = createGroupSnapshot(4);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const message = readStoredALMessage(entry);
        const envelope = readJsonObject(message.payload.resource, 'topology work envelope');
        const resourceId = toRtcRttTopologyOutboxId(
            toRtcRttMutationReceiptId(rtt('session-a', 'session-b', 1)),
            group.group,
            `sha256:${'a'.repeat(64)}`
        );
        const retiredRttMessage: ALMessage = {
            ...message,
            route: {
                ...message.route,
                resourceId: toAppQueueKey({ ...message.route, resourceId }).resourceId
            },
            payload: {
                ...message.payload,
                resource: JSON.stringify({ ...envelope, resourceId })
            }
        };
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: () => {
                throw new Error('Malformed topology work must not read mutable authority');
            },
            readCurrentGroupSnapshot: async () => {
                throw new Error('Malformed topology work must not read mutable authority');
            },
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
        });

        expect(() => readRtcTopologyWorkEnvelope(retiredRttMessage, runtime.workType)).toThrow(
            'RTC topology group-revision work cannot use an RTT durable identity'
        );
        await expect(handler.onMessage(retiredRttMessage, entry)).rejects.toBeInstanceOf(TypeError);
    });

    it('rejects RTT work that combines coalesced metadata with a durable identity', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue)
        });
        const group = createGroupSnapshot(4);
        await runtime.publisher.enqueueForRtt(group, rtt('session-a', 'session-b', 1), 0);
        const [entry] = await entriesIn(queue);
        const message = readStoredALMessage(entry);
        const envelope = readJsonObject(message.payload.resource, 'topology work envelope');
        const resourceId = toRtcRttTopologyOutboxId(
            toRtcRttMutationReceiptId(rtt('session-c', 'session-d', 2)),
            group.group,
            `sha256:${'b'.repeat(64)}`
        );
        const hybridRttMessage: ALMessage = {
            ...message,
            route: {
                ...message.route,
                resourceId: toAppQueueKey({ ...message.route, resourceId }).resourceId
            },
            payload: {
                ...message.payload,
                resource: JSON.stringify({ ...envelope, resourceId })
            }
        };
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: () => {
                throw new Error('Malformed topology work must not read mutable authority');
            },
            readCurrentGroupSnapshot: async () => {
                throw new Error('Malformed topology work must not read mutable authority');
            },
            readRttMeasurements: () => [],
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: topologyManagement.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
        });

        expect(() => readRtcTopologyWorkEnvelope(hybridRttMessage, runtime.workType)).toThrow(
            'RTC topology RTT work cannot combine coalesced and durable identity'
        );
        await expect(handler.onMessage(hybridRttMessage, entry)).rejects.toBeInstanceOf(TypeError);
    });

    it('keeps a reserved RTT generation immutable and creates a drainable successor', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000
        });
        const group = createGroupSnapshot(3);
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 10,
            createdAtEpochMs: 1_000,
            version: 1
        };
        await runtime.publisher.enqueueForRtt(group, rtt, 0);
        const reserved = await queue.reserveEntries(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            new Set([EntityStatus.NEW]),
            1
        );
        const reservedEntry = [...reserved.values()][0]!;

        await runtime.publisher.enqueueForRtt(
            group,
            { ...rtt, version: 2, createdAtEpochMs: 1_001 },
            0
        );

        expect(readWork(reservedEntry)).toMatchObject({
            kind: 'rtt-refresh',
            requestedRttVersion: 1,
            requestedAtEpochMs: 1_000,
            groupSnapshot: group
        });
        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(2);
        expect(
            entries.some(
                (entry) =>
                    entry.status === EntityStatus.NEW &&
                    (readWork(entry) as RtcTopologyRttRefreshWork).requestedRttVersion === 2
            )
        ).toBe(true);
    });

    it('uses collision-safe canonical RTT pair identities for successor resources', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000
        });
        const group = createGroupSnapshot(3);
        const composed = '\u00e9';
        const decomposed = 'e\u0301';

        await runtime.publisher.enqueueForRtt(group, rtt('reserved-a', 'reserved-b', 1), 0);
        await queue.reserveEntries(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            new Set([EntityStatus.NEW]),
            1
        );

        for (
            const measurement of [
                rtt('a', 'b:c', 1),
                rtt('a:b', 'c', 1),
                rtt(composed, 'z', 1),
                rtt(decomposed, 'z', 1),
                rtt('b:c', 'a', 1)
            ]
        ) {
            await runtime.publisher.enqueueForRtt(group, measurement, 0);
        }

        const resourceIds = (await entriesIn(queue)).map((entry) => readEnvelope(entry).resourceId);
        expect(resourceIds).toHaveLength(5);
        expect(new Set(resourceIds).size).toBe(5);
    });

    it('coalesces RTT work to the newest exact group snapshot and request time', async () => {
        const queue = new InMemoryQueueBox();
        let now = 1_000;
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => now
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 10,
            createdAtEpochMs: 1_000,
            version: 1
        };

        await runtime.publisher.enqueueForRtt(revision1, rtt, 100);
        now = 1_100;
        await runtime.publisher.enqueueForRtt(revision2, { ...rtt, version: 2 }, 100);
        now = 1_200;
        await runtime.publisher.enqueueForRtt(revision2, rtt, 100);

        const [entry] = await entriesIn(queue);
        expect(readWork(entry)).toMatchObject({
            kind: 'rtt-refresh',
            groupSnapshot: revision2,
            requestedGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 0 },
            requestedRttVersion: 2,
            rtt: { ...rtt, version: 2 },
            requestedAtEpochMs: 1_200
        });
    });

    it('skips sub-threshold RTT work before planning and reuses a qualifying retry decision', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000
        });
        let predictedDistanceMs = 0;
        const observedRttVersions: number[] = [];
        const observeRtt = (measurement: RttMeasurementInfo) => {
            observedRttVersions.push(measurement.version);
            predictedDistanceMs += 4;
            return true;
        };
        const refinement = new RtcRttRefinementService({
            gate: new RtcRttRefinementGate({
                minIntervalMs: 0,
                vivaldiDeltaThresholdMs: 10
            }),
            nowEpochMs: () => 1_000,
            observeRtt,
            readPredictedNodeData: () => predictedNodes(predictedDistanceMs)
        });
        const planned = new Error('planned');
        const readTopologyPlanningAuthority = async () => {
            throw planned;
        };
        const runtimeRepository = new FakeRuntimeStateRepository();
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: {
                readTopologyPlanningAuthority,
                computeTopologyFromAuthority: vi.fn(),
                observeCommittedTopology: vi.fn(),
                recordTopologyPublication: vi.fn(),
                recordTopologyPlanFrozen: vi.fn(),
                recordTopologyRebuildSkippedFingerprint: vi.fn()
            },
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
            rttRefinementService: refinement
        });
        const group = createGroupSnapshot(3);

        for (const version of [1, 2]) {
            const entry = await enqueueAndReserveRtt({ queue, runtime, group, version });
            await expect(handler.onMessage(JSON.parse(entry.resource), entry)).resolves.toBeUndefined();
        }
        const qualifying = await enqueueAndReserveRtt({
            queue,
            runtime,
            group,
            version: 3
        });
        await expect(handler.onMessage(JSON.parse(qualifying.resource), qualifying)).rejects.toBe(
            planned
        );
        await expect(handler.onMessage(JSON.parse(qualifying.resource), qualifying)).rejects.toBe(
            planned
        );
        expect(observedRttVersions).toEqual([1, 2, 3]);
    });

    // The refinement gate defers the replan, never the activation decision:
    // deferred RTT work for a connecting group still petitions the
    // criterion, so the measurement that crosses the threshold activates the
    // group instead of waiting for the deadline evaluation.
    it('petitions the criterion for a connecting group when the gate defers the replan', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000
        });
        const refinement = new RtcRttRefinementService({
            gate: new RtcRttRefinementGate({
                minIntervalMs: 0,
                vivaldiDeltaThresholdMs: Number.MAX_SAFE_INTEGER
            }),
            nowEpochMs: () => 1_000,
            observeRtt: () => true,
            readPredictedNodeData: () => predictedNodes(4)
        });
        const base = createGroupSnapshot(3);
        const group: GroupSnapshot = {
            ...base,
            group: {
                ...base.group,
                lifecycleState: 'connecting',
                establishmentStartedAtEpochMs: 500
            }
        };
        const planned = {
            sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: 0 },
            state: 'active',
            overlayId: toScopedOverlayId(group.group),
            groupRef: group.group,
            name: 'room-1',
            topology: 'star',
            activeSessionIds: ['session-a', 'session-b'],
            nextHopsBySessionId: {
                'session-a': ['session-b'],
                'session-b': ['session-a']
            },
            degreeLimit: 5,
            version: 1,
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1
        } as const;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        await expect(snapshots.commitSnapshot({ candidate: planned })).resolves.toMatchObject({
            status: 'accepted'
        });
        const planning = createGroupTopologyRuntimeOwners({
            findGroupSnapshotByRef: async () => group,
            readCurrentGroupSnapshot: async () => group,
            readRttMeasurements: () => [rtt('session-a', 'session-b', 1)],
            topologyService: new RallarRtcTopologyService({ now: () => 1_000 }),
            topologySnapshotRepository: snapshots
        }).planning;
        const authority = await planning.readTopologyPlanningAuthority({
            groupRef: group.group,
            knownGroup: group,
            snapshotSelection: 'prefer-current'
        });
        const submittedCommands: Array<
            Readonly<{
                command: GroupMutationCommand;
                atEpochMs: number;
            }>
        > = [];
        const submitCommand = async (command: GroupMutationCommand, atEpochMs: number) => {
            submittedCommands.push({ command, atEpochMs });
        };
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: {
                readTopologyPlanningAuthority: async () => authority,
                computeTopologyFromAuthority: vi.fn(),
                observeCommittedTopology: vi.fn(),
                recordTopologyPublication: vi.fn(),
                recordTopologyPlanFrozen: vi.fn(),
                recordTopologyRebuildSkippedFingerprint: vi.fn()
            },
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
            rttRefinementService: refinement,
            formationCriterion: {
                readLifecyclePolicy: async () => ({
                    status: 'present',
                    policy: {
                        ...createDefaultGroupLifecyclePolicy(),
                        activation: {
                            mode: 'threshold',
                            successRate: 1,
                            minimumViableRate: 0,
                            deadlineMs: 0,
                            maxFormationAttempts: 1,
                            strictConfirmation: false
                        }
                    }
                }),
                submitCommand
            }
        });

        const entry = await enqueueAndReserveRtt({
            queue,
            runtime,
            group,
            version: 1
        });
        await expect(handler.onMessage(JSON.parse(entry.resource), entry)).resolves.toBeUndefined();

        expect(submittedCommands).toEqual([
            expect.objectContaining({ atEpochMs: 1_000 })
        ]);
    });

    it('claims zero-knob RTT work and reuses its canonical observation on retry', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000
        });
        const observedRttVersions: number[] = [];
        const observeRtt = (measurement: RttMeasurementInfo) => {
            observedRttVersions.push(measurement.version);
            return true;
        };
        const refinement = new RtcRttRefinementService({
            gate: new RtcRttRefinementGate({ minIntervalMs: 0, vivaldiDeltaThresholdMs: 0 }),
            nowEpochMs: () => 1_000,
            observeRtt,
            readPredictedNodeData: () => predictedNodes(0)
        });
        const planned = new Error('planned');
        const readTopologyPlanningAuthority = async () => {
            throw planned;
        };
        const handler = createRtcTopologyWorkHandler({
            runtime,
            database: createAppInboxTestDatabase(queue, {
                replace: async (entry) => entry
            }),
            topologyPlanning: {
                readTopologyPlanningAuthority,
                computeTopologyFromAuthority: vi.fn(),
                observeCommittedTopology: vi.fn(),
                recordTopologyPublication: vi.fn(),
                recordTopologyPlanFrozen: vi.fn(),
                recordTopologyRebuildSkippedFingerprint: vi.fn()
            },
            executionRepository: new RtcTopologyExecutionRepository(new FakeRuntimeStateRepository()),
            rttRefinementService: refinement
        });
        const canonical = await enqueueAndReserveRtt({
            queue,
            runtime,
            group: createGroupSnapshot(3),
            version: 1
        });
        await expect(handler.onMessage(JSON.parse(canonical.resource), canonical)).rejects.toBe(
            planned
        );
        await expect(handler.onMessage(JSON.parse(canonical.resource), canonical)).rejects.toBe(
            planned
        );
        expect(observedRttVersions).toEqual([1]);
    });
});

async function entriesIn(queue: InMemoryQueueBox) {
    return await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key))).then(
        (entries) => entries.filter((entry) => entry !== undefined)
    );
}

function readWork(entry: {
    resource: string;
}): RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork {
    const message = decodePersistedALMessage(entry.resource);
    return readRtcTopologyWorkEnvelope(message, message.payload.typeId).data;
}

function readEnvelope(entry: { resource: string; }): StoredRtcTopologyEnvelope {
    const message = decodePersistedALMessage(entry.resource);
    const envelope = readRtcTopologyWorkEnvelope(message, message.payload.typeId);
    return { resourceId: envelope.resourceId, data: envelope.data };
}

function readStoredALMessage(entry: { resource: string; }): ALMessage {
    return decodePersistedALMessage(entry.resource);
}

function readJsonObject(serialized: string, label: string): JsonWireObject {
    return requireJsonObject(
        decodeJsonWireValue(JSON.parse(serialized), label),
        label
    );
}

function requireJsonObject(value: JsonWireValue, label: string): JsonWireObject {
    if (!isJsonObject(value)) {
        throw new TypeError(`Expected ${label}`);
    }
    return value;
}

function isJsonObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rtt(sessionIdFrom: string, sessionIdTo: string, version: number) {
    return {
        sessionIdFrom,
        sessionIdTo,
        rttMs: version,
        createdAtEpochMs: version,
        version
    };
}

async function enqueueAndReserveRtt(input: EnqueueAndReserveRttInput) {
    const { queue, runtime, group, version } = input;
    await runtime.publisher.enqueueForRtt(group, rtt('session-a', 'session-b', version), 0);
    const reserved = await queue.reserveEntries(
        OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
        new Set([EntityStatus.NEW]),
        1
    );
    const entry = [...reserved.values()][0];
    if (!entry) {
        throw new Error('Expected reserved RTC RTT work');
    }
    return entry;
}

function predictedNodes(distanceMs: number): ReadonlyMap<string, VivaldiNodeData> {
    return new Map([
        ['session-a', { id: 'session-a', coords: [0], err: 0.1, rttMs: 0 }],
        ['session-b', { id: 'session-b', coords: [distanceMs], err: 0.1, rttMs: 0 }]
    ]);
}

function createGroupSnapshot(groupRevision: number): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const groupId = 'room-1';
    return {
        causalRevision: {
            groupRevision,
            presenceRevision: 0
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            snapshotVersion: groupRevision,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: createAuditStamp(1),
            updated: createAuditStamp(groupRevision)
        }),
        members: [
            {
                applicationId,
                workspaceId,
                groupId,
                principalId: 'owner',
                role: 'owner',
                status: 'active',
                joined: createAuditStamp(1),
                updated: createAuditStamp(groupRevision),
                left: null,
                removed: null,
                banned: null,
                invitedByPrincipalId: null,
                invitationExpiresAtEpochMs: null
            }
        ],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
}

function createGroupSnapshotWithCausalRevision(
    groupRevision: number,
    presenceRevision: number
): GroupSnapshot {
    const snapshot = createGroupSnapshot(groupRevision);
    return {
        ...snapshot,
        causalRevision: { groupRevision, presenceRevision },
        group: {
            ...snapshot.group,
            snapshotVersion: groupRevision,
            presenceVersion: presenceRevision
        }
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service' as const, serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
