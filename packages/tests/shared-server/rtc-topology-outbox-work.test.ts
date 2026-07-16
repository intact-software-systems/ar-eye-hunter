import { describe, expect, it, vi } from 'vitest';
import {
    EntityStatus,
    InMemoryQueueBox,
    JsonWebSocketServer,
    type ALMessage,
} from '@shared/mod.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import {
    createRtcTopologyOutboxPublisher,
    createRtcTopologyWorkHandler,
    type RtcTopologyGroupRevisionWork,
    type RtcTopologyRttRefreshWork,
} from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import type { GroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { GroupTopologyManagementService as ConcreteGroupTopologyManagementService } from '@shared-server/rallar-system/services/group-topology-management-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('RTC topology APP_OUTBOX work', () => {
    it('keeps each committed group revision as an immutable queue entry', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
            senderId: 'server-a',
        });
        const revision1 = createGroupSnapshot(1);
        const revision2 = createGroupSnapshot(2);

        await runtime.publisher.enqueueForGroupSnapshot(revision1);
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
            }),
            expect.objectContaining({
                kind: 'group-revision',
                sourceGroupStateRevision: 2,
                groupSnapshot: revision2,
            }),
        ]));
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
        const reconfigureGroupTopology = vi.fn().mockResolvedValue({});
        const findGroupSnapshotByRef = vi.fn(() => {
            throw new Error('group-revision work must not resolve latest state');
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            findGroupSnapshotByRef,
            topologyManagement: {
                reconfigureGroupTopology,
            } as unknown as GroupTopologyManagementService,
            server: new JsonWebSocketServer(),
        });

        await handler.onMessage(message, entry, new JsonWebSocketServer());

        expect(findGroupSnapshotByRef).not.toHaveBeenCalled();
        expect(reconfigureGroupTopology).toHaveBeenCalledWith(
            expect.objectContaining({
                groupRef: exact.group,
                groupSnapshot: exact,
            }),
        );
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
            minRttVersion: 1,
        });
        const entries = await entriesIn(queue);
        expect(entries).toHaveLength(2);
        expect(entries.some((entry) =>
            entry.status === EntityStatus.NEW &&
            (readWork(entry) as RtcTopologyRttRefreshWork).minRttVersion === 2
        )).toBe(true);
    });

    it('allows N+1 then N processing while durable latest and retries converge', async () => {
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
        const updateGroupTopology = vi.spyOn(
            topologyService,
            'updateGroupTopology',
        );
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => {
                throw new Error('immutable group work must provide its snapshot');
            },
            topologyService,
            topologySnapshotRepository: topologyRepository,
            processRttReader: () => [],
        });
        const publicationRepository = new RtcTopologyPublicationRepository(
            runtimeRepository,
        );
        const publish = vi.fn().mockResolvedValue(0);
        const handler = createRtcTopologyWorkHandler({
            runtime,
            findGroupSnapshotByRef: () => undefined,
            topologyManagement,
            server: new JsonWebSocketServer(),
            publicationRepository,
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
            now: () => 20,
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
        )).toEqual([2, 1, 1]);
        expect(updateGroupTopology).toHaveBeenCalledTimes(2);
    });

    it('publishes RTT work with the resolved revision and retries from durable publication', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(queue),
        });
        const requestedGroup = createGroupSnapshot(1);
        const resolvedGroup = createGroupSnapshot(2);
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
        const updateGroupTopology = vi.spyOn(
            topologyService,
            'updateGroupTopology',
        );
        const topologyManagement = new ConcreteGroupTopologyManagementService({
            findGroupSnapshotByRef: () => resolvedGroup,
            topologyService,
            topologySnapshotRepository: topologyRepository,
            processRttReader: () => [],
        });
        const publicationRepository = new RtcTopologyPublicationRepository(
            runtimeRepository,
        );
        const publish = vi.fn().mockResolvedValue(0);
        let allowResolution = true;
        const findGroupSnapshotByRef = vi.fn(() => {
            if (!allowResolution) {
                throw new Error('retry must use the durable publication');
            }
            return resolvedGroup;
        });
        const handler = createRtcTopologyWorkHandler({
            runtime,
            findGroupSnapshotByRef,
            topologyManagement,
            server: new JsonWebSocketServer(),
            publicationRepository,
            publicationFanout: {
                readiness: Promise.resolve(),
                publish,
                deliverLocal: () => 0,
            },
            now: () => 20,
        });

        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
            new JsonWebSocketServer(),
        );
        allowResolution = false;
        await handler.onMessage(
            JSON.parse(entry.resource),
            entry,
            new JsonWebSocketServer(),
        );

        expect(findGroupSnapshotByRef).toHaveBeenCalledTimes(1);
        expect(publish.mock.calls.map(([publication]) =>
            publication.sourceGroupStateRevision
        )).toEqual([2, 2]);
        expect(updateGroupTopology).toHaveBeenCalledTimes(1);
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
