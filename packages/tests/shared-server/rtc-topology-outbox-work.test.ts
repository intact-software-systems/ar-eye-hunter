import { describe, expect, it, vi } from 'vitest';
import {
    EntityStatus,
    InMemoryQueueBox,
    type ALMessage,
} from '@shared/mod.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import {
    createRtcTopologyOutboxPublisher,
    createRtcTopologyWorkHandler,
    type RtcTopologyGroupRevisionWork,
    type RtcTopologyRttRefreshWork,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { GroupTopologyManagementService as ConcreteGroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import {
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RtcTopologySnapshotRepository,
} from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import {
    DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    type RtcTopologyPublication,
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    RuntimeStateWriteConflictError,
} from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('RTC topology APP_OUTBOX work', () => {
    it('keeps each committed group revision as an immutable queue entry', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            senderId: 'server-a',
            now: () => 100,
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);

        expect(await runtime.publisher.enqueueForGroupSnapshot(revision1))
            .toBeUndefined();
        await runtime.publisher.enqueueForGroupSnapshot(revision2);

        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => readEnvelope(entry).resourceId).sort()).toEqual([
            expect.stringContaining('group-revision:1'),
            expect.stringContaining('group-revision:2'),
        ]);
        expect(entries.map(readWork)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'group-revision',
                sourceGroupStateRevision: 1,
                groupSnapshot: revision1,
                requestedAtEpochMs: 100,
            }),
            expect.objectContaining({
                kind: 'group-revision',
                sourceGroupStateRevision: 2,
                groupSnapshot: revision2,
                requestedAtEpochMs: 100,
            }),
        ]));
    });

    it('returns the durable winner revision for a mutation-stable resource id', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            senderId: 'server-a',
            now: () => 100,
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);
        const deliveryId =
            'state-mutation-1:rtc-topology-recompute:snapshot';

        const first = await runtime.publisher.enqueueForStateMutation(
            revision1,
            deliveryId,
        );
        const duplicate = await runtime.publisher.enqueueForStateMutation(
            revision2,
            deliveryId,
        );

        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(1);
        expect(readWork(entries[0]!)).toMatchObject({
            sourceGroupStateRevision: 1,
            groupSnapshot: revision1,
        });
        expect(first).toEqual({ effectiveSnapshotRevision: 1 });
        expect(duplicate).toEqual({ effectiveSnapshotRevision: 1 });
    });

    it('processes a group revision after resolving current authority', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
        });
        const exact = createGroupSnapshot(4);
        await runtime.publisher.enqueueForGroupSnapshot(exact);
        const [entry] = await entriesIn(queue);
        const message = readStoredALMessage(entry);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyService = new RallarRtcTopologyService({ now: () => 10 });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopologyAt');
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => exact,
            topologyService,
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
            ),
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
        });

        await handler.onMessage(message, entry);

        expect(planGroupTopology).toHaveBeenCalledWith(
            exact,
            [],
            expect.any(Object),
            10,
        );
        expect(publish).toHaveBeenCalledOnce();
    });

    it.each([
        'missing-causal-revision',
        'wrong-sender',
        'wrong-type',
    ] as const)(
        'rejects %s work before reading mutable authority or publishing',
        async (defect) => {
            const queue = new InMemoryQueueBox();
            const runtime = createRtcTopologyOutboxPublisher({
                outboxQueueReader: new OutboxQueueReader(queue),
            });
            const group = createGroupSnapshot(4);
            await runtime.publisher.enqueueForGroupSnapshot(group);
            const [entry] = await entriesIn(queue);
            const message = readStoredALMessage(entry);
            let corruptMessage: ALMessage;
            if (defect === 'wrong-sender') {
                corruptMessage = {
                    ...message,
                    id: { ...message.id, senderId: 'wrong-server' },
                };
            } else if (defect === 'wrong-type') {
                corruptMessage = {
                    ...message,
                    payload: { ...message.payload, typeId: 'wrong-work-type' },
                };
            } else {
                const envelope: unknown = JSON.parse(message.payload.resource);
                if (!isUnknownRecord(envelope)) {
                    throw new Error('Expected a topology work envelope');
                }
                const data = envelope.data;
                if (!isUnknownRecord(data)) {
                    throw new Error('Expected topology work data');
                }
                const groupSnapshot = data.groupSnapshot;
                if (!isUnknownRecord(groupSnapshot)) {
                    throw new Error('Expected a topology work group snapshot');
                }
                const {
                    causalRevision: _causalRevision,
                    ...snapshotWithoutCausalRevision
                } = groupSnapshot;
                corruptMessage = {
                    ...message,
                    payload: {
                        ...message.payload,
                        resource: JSON.stringify({
                            ...envelope,
                            data: {
                                ...data,
                                groupSnapshot: snapshotWithoutCausalRevision,
                            },
                        }),
                    },
                };
            }
            const runtimeRepository = new FakeRuntimeStateRepository();
            const topologyManagement = new ConcreteGroupTopologyManagementService({
                findGroupSnapshotByRef: () => group,
                topologyService: new RallarRtcTopologyService({ now: () => 10 }),
                topologySnapshotRepository: new RtcTopologySnapshotRepository(
                    runtimeRepository,
                ),
                processRttReader: () => [],
            });
            const readAuthority = vi.spyOn(
                topologyManagement,
                'readTopologyPlanningAuthority',
            );
            const publish = vi.fn().mockResolvedValue(0);
            const handler = createRtcTopologyWorkHandler({
                runtime,
                topologyManagement,
                executionRepository: new RtcTopologyExecutionRepository(
                    runtimeRepository,
                ),
                publicationFanout: {
                    readiness: Promise.resolve(),
                    publish,
                    deliverLocal: () => 0,
                },
            });

            await expect(handler.onMessage(
                corruptMessage,
                entry,
            )).rejects.toBeInstanceOf(TypeError);
            expect(readAuthority).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
        },
    );

    it('keeps a reserved RTT generation immutable and creates a drainable successor', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000,
        });
        const group = createGroupSnapshot(3);
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 10,
            createdAtEpochMs: 1_000,
            version: 1,
        };
        await runtime.publisher.enqueueForRtt(group, rtt, 0);
        const reserved = await queue.reserveEntries(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            new Set([EntityStatus.NEW]),
            1,
        );
        const reservedEntry = [...reserved.values()][0]!;

        await runtime.publisher.enqueueForRtt(
            group,
            { ...rtt, version: 2, createdAtEpochMs: 1_001 },
            0,
        );

        expect(readWork(reservedEntry)).toMatchObject({
            kind: 'rtt-refresh',
            requestedRttVersion: 1,
            requestedAtEpochMs: 1_000,
            groupSnapshot: group,
        });
        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(2);
        expect(entries.some((entry) =>
            entry.status === EntityStatus.NEW &&
            (readWork(entry) as RtcTopologyRttRefreshWork).requestedRttVersion === 2
        )).toBe(true);
    });

    it('uses collision-safe canonical RTT pair identities for successor resources', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 1_000,
        });
        const group = createGroupSnapshot(3);
        const composed = '\u00e9';
        const decomposed = 'e\u0301';

        await runtime.publisher.enqueueForRtt(group, rtt('reserved-a', 'reserved-b', 1), 0);
        await queue.reserveEntries(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            new Set([EntityStatus.NEW]),
            1,
        );

        for (const measurement of [
            rtt('a', 'b:c', 1),
            rtt('a:b', 'c', 1),
            rtt(composed, 'z', 1),
            rtt(decomposed, 'z', 1),
            rtt('b:c', 'a', 1),
        ]) {
            await runtime.publisher.enqueueForRtt(group, measurement, 0);
        }

        const resourceIds = (await entriesIn(queue)).map((entry) =>
            readEnvelope(entry).resourceId
        );
        expect(resourceIds).toHaveLength(5);
        expect(new Set(resourceIds).size).toBe(5);
    });

    it('coalesces RTT work to the newest exact group snapshot and request time', async () => {
        const queue = new InMemoryQueueBox();
        let now = 1_000;
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => now,
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);
        const rtt = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 10,
            createdAtEpochMs: 1_000,
            version: 1,
        };

        await runtime.publisher.enqueueForRtt(revision1, rtt, 100);
        now = 1_100;
        await runtime.publisher.enqueueForRtt(
            revision2,
            { ...rtt, version: 2 },
            100,
        );

        const [entry] = await entriesIn(queue);
        expect(readWork(entry)).toMatchObject({
            kind: 'rtt-refresh',
            groupSnapshot: revision2,
            requestedGroupStateRevision: 2,
            requestedRttVersion: 2,
            requestedAtEpochMs: 1_100,
        });
    });

    it('reuses the atomically committed publication after fanout fails', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 100,
        });
        const group = createGroupSnapshot(3);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyService = new RallarRtcTopologyService({ now: () => 10 });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopologyAt');
        let currentGroup = group;
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => currentGroup,
            topologyService,
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const executionRepository = new RtcTopologyExecutionRepository(
            runtimeRepository,
        );
        const publish = vi.fn()
            .mockRejectedValueOnce(new Error('fanout failed'))
            .mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository,
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
        });
        const message = JSON.parse(entry.resource) as ALMessage;

        await expect(
            handler.onMessage(message, entry),
        ).rejects.toThrow('fanout failed');
        currentGroup = createGroupSnapshot(4);
        await handler.onMessage(message, entry);

        expect(planGroupTopology).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1][0]).toEqual(publish.mock.calls[0][0]);
        expect(publish.mock.calls[0][0].createdAtEpochMs).toBe(100);
    });

    it('replays a durable publication before consulting mutable planning authority', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 100,
        });
        const group = createGroupSnapshot(3);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const readAuthority = vi.spyOn(
            topologyManagement,
            'readTopologyPlanningAuthority',
        );
        const executionRepository = new RtcTopologyExecutionRepository(
            runtimeRepository,
        );
        const publish = vi.fn()
            .mockRejectedValueOnce(new Error('fanout failed'))
            .mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository,
            publicationFanout: {
                readiness: Promise.resolve(), publish, deliverLocal: () => 0,
            },
        });
        const message = JSON.parse(entry.resource) as ALMessage;

        await expect(handler.onMessage(
            message,
            entry,
        )).rejects.toThrow('fanout failed');
        readAuthority.mockRejectedValueOnce(
            new Error('mutable authority must not be read on replay'),
        );

        await expect(handler.onMessage(
            message,
            entry,
        )).resolves.toBeUndefined();
        expect(readAuthority).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1][0]).toEqual(publish.mock.calls[0][0]);
    });

    it('rejects a corrupt execution receipt before replay fanout or mutable authority', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 100,
        });
        const group = createGroupSnapshot(3);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const message = readStoredALMessage(entry);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const readAuthority = vi.spyOn(
            topologyManagement,
            'readTopologyPlanningAuthority',
        );
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
            ),
            publicationFanout: {
                readiness: Promise.resolve(), publish, deliverLocal: () => 0,
            },
        });

        await handler.onMessage(message, entry);
        const claims = await runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        );
        const claim = claims[0];
        if (!claim) throw new Error('Expected durable topology execution receipt');
        const receipt: unknown = JSON.parse(claim.value);
        if (!isUnknownRecord(receipt)) {
            throw new Error('Expected an object topology execution receipt');
        }
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            claim.key,
            JSON.stringify({
                ...receipt,
                commandHash: `sha256:${'0'.repeat(64)}`,
            }),
            claim.expireAtTimestamp,
        );
        readAuthority.mockClear();
        publish.mockClear();

        await expect(handler.onMessage(message, entry))
            .rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
        expect(readAuthority).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it('fails closed without fanout when a durable replay publication is corrupt', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 100,
        });
        const group = createGroupSnapshot(3);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const message = JSON.parse(entry.resource) as ALMessage;
        const runtimeRepository = new FakeRuntimeStateRepository();
        let currentGroup = group;
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => currentGroup,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const executionRepository = new RtcTopologyExecutionRepository(
            runtimeRepository,
        );
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository,
            publicationFanout: {
                readiness: Promise.resolve(), publish, deliverLocal: () => 0,
            },
        });
        await handler.onMessage(message, entry);
        const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
        const stored = await snapshots.findSnapshotEntry(group.group);
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            stored!.entry.key,
            JSON.stringify({
                ...stored!.value,
                name: 'equal tuple but different durable snapshot',
            }),
            stored!.entry.expireAtTimestamp,
        );
        publish.mockClear();
        currentGroup = createGroupSnapshot(4);

        await expect(handler.onMessage(message, entry))
            .rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
        expect(publish).not.toHaveBeenCalled();
    });

    it('validates a corrupt persisted topology graph before replay fanout', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 100,
        });
        const group = createGroupSnapshot(3);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const message = JSON.parse(entry.resource) as ALMessage;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
            ),
            publicationFanout: {
                readiness: Promise.resolve(), publish, deliverLocal: () => 0,
            },
        });
        await handler.onMessage(message, entry);
        const [publicationEntry] = await runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        );
        const [snapshotEntry] = await runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
        );
        const publication = JSON.parse(publicationEntry!.value) as {
            message: ALMessage;
        };
        const snapshot = JSON.parse(publication.message.payload.resource) as
            RallarOverlayTopologySnapshot;
        const invalidSnapshot = {
            ...snapshot,
            nextHopsBySessionId: { 'unknown-session': [] },
        };
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publicationEntry!.key,
            JSON.stringify({
                ...publication,
                message: {
                    ...publication.message,
                    payload: {
                        ...publication.message.payload,
                        resource: JSON.stringify(invalidSnapshot),
                    },
                },
            }),
            publicationEntry!.expireAtTimestamp,
        );
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
            snapshotEntry!.key,
            JSON.stringify(invalidSnapshot),
            snapshotEntry!.expireAtTimestamp,
        );
        publish.mockClear();

        await expect(handler.onMessage(message, entry))
            .rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
        expect(publish).not.toHaveBeenCalled();
    });

    it.each(['id', 'route', 'typeId', 'msgId'] as const)(
        'fails closed before replay fanout when the durable envelope has invalid %s',
        async (defect) => {
            const queue = new InMemoryQueueBox();
            const runtime = createRtcTopologyOutboxPublisher({
                outboxQueueReader: new OutboxQueueReader(queue),
                now: () => 100,
            });
            const group = createGroupSnapshot(3);
            await runtime.publisher.enqueueForGroupSnapshot(group);
            const [entry] = await entriesIn(queue);
            const message = JSON.parse(entry.resource) as ALMessage;
            const runtimeRepository = new FakeRuntimeStateRepository();
            let currentGroup = group;
            const topologyManagement = new ConcreteGroupTopologyManagementService({
                findGroupSnapshotByRef: () => currentGroup,
                topologyService: new RallarRtcTopologyService({ now: () => 10 }),
                topologySnapshotRepository: new RtcTopologySnapshotRepository(
                    runtimeRepository,
                ),
                processRttReader: () => [],
            });
            const executionRepository = new RtcTopologyExecutionRepository(
                runtimeRepository,
            );
            const publish = vi.fn().mockResolvedValue(0);
            const handler = createRtcTopologyWorkHandler({
                runtime,
                topologyManagement,
                executionRepository,
                publicationFanout: {
                    readiness: Promise.resolve(), publish, deliverLocal: () => 0,
                },
            });
            await handler.onMessage(message, entry);
            const [stored] = await runtimeRepository.findAllEntries(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            );
            const publication = JSON.parse(stored!.value) as {
                message: Record<string, unknown>;
            };
            if (defect === 'typeId') {
                delete (publication.message.payload as Record<string, unknown>).typeId;
            } else if (defect === 'msgId') {
                (publication.message.id as Record<string, unknown>).msgId =
                    'tampered-message-id';
            } else {
                delete publication.message[defect];
            }
            await runtimeRepository.upsert(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                stored!.key,
                JSON.stringify(publication),
                stored!.expireAtTimestamp,
            );
            publish.mockClear();
            currentGroup = createGroupSnapshot(4);

            await expect(handler.onMessage(
                message,
                entry,
            )).rejects.toMatchObject({
                code: 'rtc-topology-repository-invariant-corruption',
            });
            expect(publish).not.toHaveBeenCalled();
        },
    );

    it('retries a torn publication-ahead read and never fans it out', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue), now: () => 100,
        });
        const group = createGroupSnapshot(2);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const message = JSON.parse(entry.resource) as ALMessage;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const executionRepository = new RtcTopologyExecutionRepository(
            runtimeRepository,
        );
        const publish = vi.fn().mockResolvedValue(0);
        const sleep = vi.fn(async () => {});
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository,
            publicationFanout: {
                readiness: Promise.resolve(), publish, deliverLocal: () => 0,
            },
            sleep,
        });
        await handler.onMessage(message, entry);
        const durable = await new RtcTopologySnapshotRepository(runtimeRepository)
            .findSnapshotEntry(group.group);
        if (!durable) throw new Error('Expected a durable topology snapshot');
        const older = {
            ...durable.value,
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1,
            },
            version: 1,
        };
        runtimeRepository.data.set(
            `${RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE}::${durable.entry.key}`,
            { ...durable.entry, value: JSON.stringify(older) },
        );
        publish.mockClear();

        await expect(handler.onMessage(message, entry))
            .rejects.toMatchObject({ code: 'rtc-topology-execution-conflict' });
        expect(publish).not.toHaveBeenCalled();
        expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2, 8]);
    });

    it('recomputes publication expiry from fresh facts on every CAS attempt', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue), now: () => 1,
        });
        const group = createGroupSnapshot(1);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        let firstClaim = true;
        runtimeRepository.beforeConditionalWrite = (operation, namespace) => {
            if (
                firstClaim && operation === 'insertIfAbsent' &&
                namespace === RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE
            ) {
                firstClaim = false;
                throw new RuntimeStateWriteConflictError();
            }
        };
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const clockValues = [100, 200];
        const executionRepository = new RtcTopologyExecutionRepository(
            runtimeRepository,
            DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
            () => clockValues.shift()!,
        );
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository,
            publicationFanout: {
                readiness: Promise.resolve(),
                publish: vi.fn().mockResolvedValue(0),
                deliverLocal: () => 0,
            },
            sleep: async () => {},
        });

        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
        );

        const [stored] = await runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        );
        expect(stored?.expireAtTimestamp).toBe(
            200 + DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
        );
        expect(clockValues).toEqual([]);
    });

    it('retries inactive fanout with a byte-equivalent durable tombstone', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            now: () => 100,
        });
        const active = createGroupSnapshot(3);
        const group: GroupSnapshot = {
            ...active,
            stateRevision: 4,
            causalRevision: { groupRevision: 4, presenceRevision: 0 },
            group: {
                ...active.group,
                status: 'deleted',
                updated: createAuditStamp(123),
                archived: null,
                deleted: createAuditStamp(123),
            },
            activeSessions: [],
            onlineMemberCount: 0,
        };
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        let planningNow = 10;
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({
                now: () => planningNow,
            }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const publish = vi.fn()
            .mockRejectedValueOnce(new Error('fanout failed'))
            .mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
            ),
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
        });
        const message = JSON.parse(entry.resource) as ALMessage;

        await expect(handler.onMessage(message, entry))
            .rejects.toThrow('fanout failed');
        planningNow = 999;
        await handler.onMessage(message, entry);

        expect(JSON.stringify(publish.mock.calls[1][0]))
            .toBe(JSON.stringify(publish.mock.calls[0][0]));
        expect(publish.mock.calls[0][0].createdAtEpochMs).toBe(100);
        expect(JSON.parse(publish.mock.calls[0][0].message.payload.resource))
            .toMatchObject({ state: 'removed', updatedAtEpochMs: 123 });
    });

    it('recomputes after predecessor movement before accepting a publication', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
        });
        const group = createGroupSnapshot(3);
        await runtime.publisher.enqueueForGroupSnapshot(group);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
            topologyService: new RallarRtcTopologyService({ now: () => 10 }),
            topologySnapshotRepository: new RtcTopologySnapshotRepository(
                runtimeRepository,
            ),
            processRttReader: () => [],
        });
        const predecessor: RallarOverlayTopologySnapshot = {
            ...(await topologyManagement.planGroupTopology(group, undefined)).snapshot,
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 0,
            },
        };
        const order: string[] = [];
        const originalPlan = topologyManagement.planTopologyFromAuthority.bind(
            topologyManagement,
        );
        vi.spyOn(topologyManagement, 'planTopologyFromAuthority')
            .mockImplementation((authority, previous) => {
                order.push(
                    `plan:${previous?.sourceGroupStateCausalRevision.groupRevision ?? 0}`,
                );
                return originalPlan(authority, previous);
            });
        const readAuthority = vi.spyOn(
            topologyManagement,
            'readTopologyPlanningAuthority',
        );
        let commitCount = 0;
        const publications: RtcTopologyPublication[] = [];
        const readTopologyMutation = vi.fn(async () => ({
            snapshot: commitCount === 0
                ? null
                : {
                    entry: {
                        key: 'snapshot', value: JSON.stringify(predecessor),
                        expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                        updatedTimestamp: 'now', revision: 1,
                    },
                    value: predecessor,
                },
            publicationClaim: null,
        }));
        const executionRepository = {
            publicationExpireAtTimestamp: () => Number.MAX_SAFE_INTEGER,
            readTopologyMutation,
            writeTopologyMutation: async (computed: {
                snapshotGuard: { candidate: RallarOverlayTopologySnapshot };
                publication: RtcTopologyPublication;
            }) => {
                commitCount += 1;
                publications.push(structuredClone(computed.publication));
                order.push(
                    `commit:${computed.snapshotGuard.candidate.sourceGroupStateCausalRevision.groupRevision}`,
                );
                return commitCount === 1
                    ? 'conflict' as const
                    : 'committed' as const;
            },
        } as unknown as RtcTopologyExecutionRepository;
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository,
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
        });

        const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
            throw new Error('ambient Date.now used during topology mutation');
        });
        const randomUuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
            throw new Error('ambient random UUID used during topology mutation');
        });
        try {
            await handler.onMessage(
                JSON.parse(entry.resource),
                entry,
            );
        } finally {
            dateNow.mockRestore();
            randomUuid.mockRestore();
        }

        expect(order).toEqual(['plan:0', 'commit:3', 'plan:2', 'commit:3']);
        expect(readAuthority).toHaveBeenCalledTimes(2);
        expect(readTopologyMutation).toHaveBeenCalledTimes(2);
        expect(publications).toHaveLength(2);
        expect(publications[1]).toEqual(publications[0]);
        expect(publications[0]).toMatchObject({
            createdAtEpochMs: expect.any(Number),
            message: {
                id: { msgId: expect.any(String), ts: expect.any(Number) },
                audit: { createdTs: expect.any(Number) },
            },
        });
        expect(publications[0]!.message.id.ts).toBe(publications[0]!.createdAtEpochMs);
        expect(publications[0]!.message.audit?.createdTs)
            .toBe(publications[0]!.createdAtEpochMs);
        expect(publish).toHaveBeenCalledOnce();
    });

    it('skips older work that arrives after a newer topology is committed', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);
        await runtime.publisher.enqueueForGroupSnapshot(revision1);
        await runtime.publisher.enqueueForGroupSnapshot(revision2);
        const entries = await entriesIn(queue);
        const entry1 = entries.find((entry) =>
            (readWork(entry) as RtcTopologyGroupRevisionWork)
                .sourceGroupStateRevision === 1
        )!;
        const entry2 = entries.find((entry) =>
            (readWork(entry) as RtcTopologyGroupRevisionWork)
                .sourceGroupStateRevision === 2
        )!;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyRepository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        );
        const topologyService = new RallarRtcTopologyService({ now: () => 10 });
        const planGroupTopology = vi.spyOn(
            topologyService,
            'planGroupTopologyAt',
        );
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => revision2,
            topologyService,
            topologySnapshotRepository: topologyRepository,
            processRttReader: () => [],
        });
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
            ),
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
        });

        await handler.onMessage(
            JSON.parse(entry2.resource),
            entry2,
        );
        await handler.onMessage(
            JSON.parse(entry1.resource),
            entry1,
        );

        expect((await topologyRepository.findSnapshot(revision1.group))
            ?.sourceGroupStateCausalRevision.groupRevision).toBe(2);
        expect(topologyService.readSnapshot(revision1)
            ?.sourceGroupStateCausalRevision.groupRevision)
            .toBe(2);
        expect(publish.mock.calls.map(([publication]) =>
            publication.sourceGroupStateCausalRevision.groupRevision
        )).toEqual([2]);
        expect(planGroupTopology).toHaveBeenCalledTimes(1);
    });

    it('publishes RTT work from its exact coalesced snapshot and retries from durable publication', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
        });
        const requestedGroup = createGroupSnapshot(1);
        await runtime.publisher.enqueueForRtt(requestedGroup, {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 10,
            version: 1,
        }, 0);
        const [entry] = await entriesIn(queue);
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyRepository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        );
        const topologyService = new RallarRtcTopologyService({ now: () => 10 });
        const planGroupTopology = vi.spyOn(
            topologyService,
            'planGroupTopologyAt',
        );
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => requestedGroup,
            topologyService,
            topologySnapshotRepository: topologyRepository,
            processRttReader: () => [],
        });
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            topologyManagement,
            executionRepository: new RtcTopologyExecutionRepository(
                runtimeRepository,
            ),
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
        });

        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
        );
        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
        );

        expect(publish.mock.calls.map(([publication]) =>
            publication.sourceGroupStateCausalRevision.groupRevision
        )).toEqual([1, 1]);
        expect(planGroupTopology).toHaveBeenCalledTimes(1);
    });
});

async function entriesIn(queue: InMemoryQueueBox) {
    return await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key)),
    ).then((entries) => entries.filter((entry) => entry !== undefined));
}

function readWork(entry: { resource: string }):
    | RtcTopologyGroupRevisionWork
    | RtcTopologyRttRefreshWork {
    const message = JSON.parse(entry.resource) as ALMessage;
    const envelope = JSON.parse(message.payload.resource) as {
        data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;
    };
    return envelope.data;
}

function readEnvelope(entry: { resource: string }): {
    resourceId: string;
    data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;
} {
    const message = JSON.parse(entry.resource) as ALMessage;
    return JSON.parse(message.payload.resource);
}

function readStoredALMessage(entry: { resource: string }): ALMessage {
    const parsed: unknown = JSON.parse(entry.resource);
    if (!isUnknownRecord(parsed)) throw new Error('Expected an AL message object');
    const id = parsed.id;
    const route = parsed.route;
    const payload = parsed.payload;
    if (
        !isUnknownRecord(id) || id.v !== 2 ||
        typeof id.msgId !== 'string' || typeof id.ts !== 'number' ||
        typeof id.senderId !== 'string' ||
        !isUnknownRecord(route) || typeof route.topicId !== 'string' ||
        typeof route.resourceId !== 'string' || typeof route.contextId !== 'string' ||
        !isUnknownRecord(payload) || typeof payload.typeId !== 'string' ||
        typeof payload.resource !== 'string'
    ) {
        throw new Error('Expected a valid persisted AL message');
    }
    return {
        id: {
            v: 2,
            msgId: id.msgId,
            ts: id.ts,
            senderId: id.senderId,
        },
        route: {
            topicId: route.topicId,
            resourceId: route.resourceId,
            contextId: route.contextId,
        },
        payload: {
            typeId: payload.typeId,
            resource: payload.resource,
        },
    };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rtt(
    sessionIdFrom: string,
    sessionIdTo: string,
    version: number,
) {
    return {
        sessionIdFrom,
        sessionIdTo,
        rttMs: version,
        createdAtEpochMs: version,
        version,
    };
}

function createGroupSnapshot(stateRevision: number): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const groupId = 'room-1';
    return {
        stateRevision,
        causalRevision: {
            groupRevision: stateRevision,
            presenceRevision: 0,
        },
        group: {
            applicationId,
            workspaceId,
            groupId,
            slug: null,
            displayName: groupId,
            description: null,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: 0,
            ownerPrincipalId: 'owner',
            snapshotVersion: stateRevision,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: createAuditStamp(1),
            updated: createAuditStamp(stateRevision),
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            archived: null,
            deleted: null,
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}

function createAuditStamp(atEpochMs: number) {
    return {
        atEpochMs,
        actor: { kind: 'service' as const, serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
