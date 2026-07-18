import { describe, expect, it, vi } from 'vitest';
import {
    EntityStatus,
    InMemoryQueueBox,
    JsonWebSocketServer,
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
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
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

    it('processes a group revision from its exact snapshot without resolving latest state', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
        });
        const exact = createGroupSnapshot(4);
        await runtime.publisher.enqueueForGroupSnapshot(exact);
        const [entry] = await entriesIn(queue);
        const message = JSON.parse(entry.resource) as ALMessage;
        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyService = new RallarRtcTopologyService({ now: () => 10 });
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopology');
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => {
                throw new Error('group-revision work must not resolve latest state');
            },
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

        await handler.onMessage(message, entry, new JsonWebSocketServer());

        expect(planGroupTopology).toHaveBeenCalledWith(
            exact,
            [],
            expect.any(Object),
        );
        expect(publish).toHaveBeenCalledOnce();
    });

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
        const planGroupTopology = vi.spyOn(topologyService, 'planGroupTopology');
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => group,
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
            handler.onMessage(message, entry, new JsonWebSocketServer()),
        ).rejects.toThrow('fanout failed');
        await handler.onMessage(message, entry, new JsonWebSocketServer());

        expect(planGroupTopology).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1][0]).toEqual(publish.mock.calls[0][0]);
        expect(publish.mock.calls[0][0].createdAtEpochMs).toBe(100);
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
            group: {
                ...active.group,
                status: 'deleted',
                updated: { atEpochMs: 123 },
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

        await expect(handler.onMessage(message, entry, new JsonWebSocketServer()))
            .rejects.toThrow('fanout failed');
        planningNow = 999;
        await handler.onMessage(message, entry, new JsonWebSocketServer());

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
            sourceGroupStateRevision: 2,
        };
        const order: string[] = [];
        const originalPlan = topologyManagement.planGroupTopology.bind(
            topologyManagement,
        );
        vi.spyOn(topologyManagement, 'planGroupTopology')
            .mockImplementation(async (snapshot, previous) => {
                order.push(`plan:${previous?.sourceGroupStateRevision ?? 0}`);
                return await originalPlan(snapshot, previous);
            });
        let commitCount = 0;
        const executionRepository = {
            findPublicationForWork: () => Promise.resolve(undefined),
            findSnapshot: () => Promise.resolve(undefined),
            commit: async (input: {
                candidate: RallarOverlayTopologySnapshot;
                publication: Parameters<
                    RtcTopologyExecutionRepository['commit']
                >[0]['publication'];
            }) => {
                commitCount += 1;
                order.push(`commit:${input.candidate.sourceGroupStateRevision}`);
                return commitCount === 1
                    ? { status: 'retry' as const, current: predecessor }
                    : {
                        status: 'committed' as const,
                        snapshot: input.candidate,
                        publication: input.publication,
                    };
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

        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
            new JsonWebSocketServer(),
        );

        expect(order).toEqual(['plan:0', 'commit:3', 'plan:2', 'commit:3']);
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
            'planGroupTopology',
        );
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => {
                throw new Error('immutable group work must provide its snapshot');
            },
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
            new JsonWebSocketServer(),
        );
        await handler.onMessage(
            JSON.parse(entry1.resource),
            entry1,
            new JsonWebSocketServer(),
        );

        expect((await topologyRepository.findSnapshot(revision1.group))
            ?.sourceGroupStateRevision).toBe(2);
        expect(topologyService.readSnapshot(revision1)?.sourceGroupStateRevision)
            .toBe(2);
        expect(publish.mock.calls.map(([publication]) =>
            publication.sourceGroupStateRevision
        )).toEqual([2]);
        expect(planGroupTopology).toHaveBeenCalledTimes(2);
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
            'planGroupTopology',
        );
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => {
                throw new Error('RTT work must retain its exact group snapshot');
            },
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
            new JsonWebSocketServer(),
        );
        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
            new JsonWebSocketServer(),
        );

        expect(publish.mock.calls.map(([publication]) =>
            publication.sourceGroupStateRevision
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

function createGroupSnapshot(stateRevision: number): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const groupId = 'room-1';
    return {
        stateRevision,
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: stateRevision,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: stateRevision,
            created: { atEpochMs: 1 },
            updated: { atEpochMs: stateRevision },
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}
