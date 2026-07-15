import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { AppTopics } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { findClientStateSnapshotByPrincipalId } from '@shared/repository/client-state-snapshots-repository.ts';
import { findGroupStateSnapshotByRef } from '@shared/repository/group-state-snapshots-repository.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    AppClientInboxService,
    type ClientPrincipalUpsertAppInboxPayload,
    type ClientSessionConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
    AppGroupInboxService,
    AppInboxType,
    type GroupMutationOutboxPublisher,
    type GroupCreateAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

describe('state sync publish failure characterization', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('app inbox commits group state and updates process cache before retrying snapshot enqueue failure', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async () => {
            throw new Error('snapshot enqueue unavailable');
        });
        const { appInbox, reader, queue, results } = createGroupAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            1_000,
        );
        const groupRef = {
            ...SCOPE,
            groupId: 'room-1',
        };

        const entry = await processCreateGroup(
            appInbox,
            reader,
            queue,
            groupRef.groupId,
        );

        const durableRepository = new GroupStateRepository(runtimeRepository);
        const durableSnapshot = await durableRepository.readSnapshot(groupRef);
        expect(durableSnapshot?.group).toMatchObject({
            ...groupRef,
            snapshotVersion: 1,
        });
        expect(await durableRepository.listEvents(groupRef)).toHaveLength(1);
        expect(findGroupStateSnapshotByRef(groupRef)?.group.snapshotVersion).toBe(
            1,
        );
        expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
        expect(firstEnqueuedMessage(enqueueOutboxIfAbsent).payload.typeId).toBe(
            AppTopics.groupStateSnapshot,
        );
        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toBeUndefined();
    });

    it('keeps a committed group mutation retryable when APP_OUTBOX registration fails', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => ({
            status: 'enqueued',
            message,
            entries: [],
        }));
        const groupMutationOutboxPublisher = {
            enqueueForGroupSnapshot: vi.fn(async () => {
                throw new Error('app outbox unavailable');
            }),
        };
        const { appInbox, reader, queue, results } = createGroupAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            1_500,
            groupMutationOutboxPublisher,
        );

        const entry = await processCreateGroup(
            appInbox,
            reader,
            queue,
            'room-app-outbox-failure',
        );

        const groupRef = {
            ...SCOPE,
            groupId: 'room-app-outbox-failure',
        };
        expect(
            await new GroupStateRepository(runtimeRepository)
                .readSnapshot(groupRef),
        ).toBeDefined();
        expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(3);
        expect(groupMutationOutboxPublisher.enqueueForGroupSnapshot)
            .toHaveBeenCalledOnce();
        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(await results.findByKey(entry.key)).toBeUndefined();
    });

    it('app inbox commits client state and updates process cache before retrying snapshot enqueue failure', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async () => {
            throw new Error('client snapshot enqueue unavailable');
        });
        const { appInbox, reader, queue, results } = createClientAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            2_000,
        );

        const entry = await processUpsertClientPrincipal(
            appInbox,
            reader,
            queue,
            'alice',
        );

        const principalRef = {
            ...SCOPE,
            principalId: 'alice',
        };
        const durableRepository = new ClientStateRepository(runtimeRepository);
        const durableSnapshot = await durableRepository.readSnapshot(principalRef);
        expect(durableSnapshot?.principal).toMatchObject({
            ...principalRef,
            snapshotVersion: 1,
        });
        expect(await durableRepository.listEvents(principalRef)).toHaveLength(1);
        expect(
            findClientStateSnapshotByPrincipalId('alice')?.principal.snapshotVersion,
        ).toBe(1);
        expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
        expect(firstEnqueuedMessage(enqueueOutboxIfAbsent).payload.typeId).toBe(
            AppTopics.clientStateSnapshot,
        );
        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toBeUndefined();
    });

    it('app inbox completes an active client session connect when snapshot enqueue returns no-route', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => ({
            status: 'no-route',
            message,
            entries: [],
            reason: 'test resolver returned no recipients',
        }));
        const { appInbox, reader, queue, results } = createClientAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            2_500,
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const entry = await processConnectClientSession(
                appInbox,
                reader,
                queue,
                'alice',
                'session-alice',
            );

            const principalRef = {
                ...SCOPE,
                principalId: 'alice',
            };
            const durableSnapshot = await new ClientStateRepository(runtimeRepository)
                .readSnapshot(principalRef);
            expect(durableSnapshot?.activeSessions.map(session => session.sessionId))
                .toEqual(['session-alice']);
            expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(2);
            expect(enqueueOutboxIfAbsent.mock.calls.map(([message]) =>
                (message as ALMessage).payload.typeId
            )).toEqual([
                AppTopics.clientStateSnapshot,
                AppTopics.clientStateEvent,
            ]);
            expect(entry.status).toBe(EntityStatus.COMPLETED);
            expect(entry.dequeueAudit.attempts).toBe(1);
            expect(await results.findByKey(entry.key)).toMatchObject({
                status: EntityStatus.COMPLETED,
            });
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    it('app inbox completes an active group session connect when state sync enqueue returns no-route', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => ({
            status: 'enqueued',
            message,
            entries: [],
        }));
        const { appInbox, reader, queue, results } = createGroupAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            3_500,
        );
        const groupRef = {
            ...SCOPE,
            groupId: 'room-no-route',
        };

        await processCreateGroup(
            appInbox,
            reader,
            queue,
            groupRef.groupId,
        );
        await processUpsertGroupMember(
            appInbox,
            reader,
            queue,
            groupRef.groupId,
            'alice',
        );
        enqueueOutboxIfAbsent.mockClear();
        enqueueOutboxIfAbsent.mockImplementation(async (message: ALMessage) => ({
            status: 'no-route',
            message,
            entries: [],
            reason: 'test resolver returned no recipients',
        }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const entry = await processConnectGroupPresence(
                appInbox,
                reader,
                queue,
                groupRef.groupId,
                'alice',
                'session-alice',
            );

            const durableSnapshot = await new GroupStateRepository(runtimeRepository)
                .readSnapshot(groupRef);
            expect(durableSnapshot?.activeSessions.map(session => session.sessionId))
                .toEqual(['session-alice']);
            expect(enqueueOutboxIfAbsent).toHaveBeenCalledTimes(3);
            expect(enqueueOutboxIfAbsent.mock.calls.map(([message]) =>
                (message as ALMessage).payload.typeId
            )).toEqual([
                AppTopics.groupStateSnapshot,
                AppTopics.groupDirectorySnapshot,
                AppTopics.groupStateEvent,
            ]);
            expect(entry.status).toBe(EntityStatus.COMPLETED);
            expect(entry.dequeueAudit.attempts).toBe(1);
            expect(await results.findByKey(entry.key)).toMatchObject({
                status: EntityStatus.COMPLETED,
            });
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    it('app inbox can enqueue a group snapshot before retrying a later group event enqueue failure', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueuedMessages: ALMessage[] = [];
        const enqueueOutboxIfAbsent = vi.fn(async (message: ALMessage) => {
            enqueuedMessages.push(message);
            if (enqueuedMessages.length === 3) {
                throw new Error('event enqueue unavailable');
            }
            return {
                status: 'enqueued',
                message,
                entries: [],
            };
        });
        const { appInbox, reader, queue, results } = createGroupAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            3_000,
        );
        const groupRef = {
            ...SCOPE,
            groupId: 'room-2',
        };

        const entry = await processCreateGroup(
            appInbox,
            reader,
            queue,
            groupRef.groupId,
        );

        expect(enqueuedMessages.map((message) => message.payload.typeId)).toEqual([
            AppTopics.groupStateSnapshot,
            AppTopics.groupDirectorySnapshot,
            AppTopics.groupStateEvent,
        ]);
        expect(
            await new GroupStateRepository(runtimeRepository).readSnapshot(groupRef),
        ).toBeDefined();
        expect(findGroupStateSnapshotByRef(groupRef)).toBeDefined();
        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toBeUndefined();
    });
});

class TestResourceInbox extends InMemoryQueueBox {
    async isEntryWithStatus(
        key: Key,
        statuses: EntityStatus[],
    ): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async writeIfAbsentOrReplaceExpired(
        entry: ResourceEntry,
    ): Promise<ResourceEntry> {
        const key = toKeyAsString(entry.key);
        const existing = this.data.get(key);
        if (existing !== undefined && !isExpiredResourceEntry(existing)) {
            return existing;
        }

        this.data.set(key, entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return entry === undefined || isExpiredResourceEntry(entry)
            ? undefined
            : entry;
    }
}

function createGroupAppInbox(
    runtimeRepository: FakeRuntimeStateRepository,
    publisher: ReturnType<typeof createPublisher>,
    now: number,
    groupMutationOutboxPublisher?: GroupMutationOutboxPublisher,
): Readonly<{
    appInbox: AppGroupInboxService;
    reader: InboxQueueReader;
    queue: TestResourceInbox;
    results: TestResourceInboxResults;
}> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const appInbox = new AppGroupInboxService(
        reader,
        queue as never,
        results as never,
        createGroupStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => now,
            serviceId: 'state-service',
        }),
        publisher,
        'state-service',
        undefined,
        undefined,
        groupMutationOutboxPublisher,
    );

    return {
        appInbox,
        reader,
        queue,
        results,
    };
}

function createClientAppInbox(
    runtimeRepository: FakeRuntimeStateRepository,
    publisher: ReturnType<typeof createPublisher>,
    now: number,
): Readonly<{
    appInbox: AppClientInboxService;
    reader: InboxQueueReader;
    queue: TestResourceInbox;
    results: TestResourceInboxResults;
}> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const appInbox = new AppClientInboxService(
        reader,
        queue as never,
        results as never,
        createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => now,
            serviceId: 'state-service',
        }),
        publisher,
        'state-service',
    );

    return {
        appInbox,
        reader,
        queue,
        results,
    };
}

async function processCreateGroup(
    appInbox: AppGroupInboxService,
    reader: InboxQueueReader,
    queue: InMemoryQueueBox,
    groupId: string,
): Promise<ResourceEntry> {
    const requestId = `create-${groupId}`;
    appInbox.processEntryNoWaiting<GroupCreateAppInboxPayload>({
        type: AppInboxType.GROUP_CREATE,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: 'alice',
        data: {
            scope: SCOPE,
            request: {
                groupId,
                displayName: groupId === 'room-1' ? 'Room 1' : 'Room 2',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                requestId,
            },
        },
    });

    await waitForQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    const entry = readOnlyEntry(queue);
    if (!entry) {
        throw new Error('Expected app inbox entry to remain in queue');
    }

    return entry;
}

async function processUpsertClientPrincipal(
    appInbox: AppClientInboxService,
    reader: InboxQueueReader,
    queue: InMemoryQueueBox,
    principalId: string,
): Promise<ResourceEntry> {
    const requestId = `upsert-client-${principalId}`;
    appInbox.processEntryNoWaiting<ClientPrincipalUpsertAppInboxPayload>({
        type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${principalId}`,
        senderId: principalId,
        data: {
            scope: SCOPE,
            principalId,
            request: {
                username: principalId,
                displayName: principalId === 'alice' ? 'Alice' : principalId,
                actorPrincipalId: principalId,
                requestId,
            },
        },
    });

    await waitForQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    const entry = readOnlyEntry(queue);
    if (!entry) {
        throw new Error('Expected app inbox entry to remain in queue');
    }

    return entry;
}

async function processConnectClientSession(
    appInbox: AppClientInboxService,
    reader: InboxQueueReader,
    queue: InMemoryQueueBox,
    principalId: string,
    sessionId: string,
): Promise<ResourceEntry> {
    const requestId = `connect-client-${sessionId}`;
    const clientInstanceId = `${principalId}-browser`;
    appInbox.processEntryNoWaiting<ClientSessionConnectAppInboxPayload>({
        type: AppInboxType.CLIENT_SESSION_CONNECT,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${principalId}`,
        senderId: principalId,
        data: {
            scope: SCOPE,
            principalId,
            clientInstanceId,
            sessionId,
            request: {
                presenceState: 'online',
                transport: 'ws',
                actorPrincipalId: principalId,
                actorSessionId: sessionId,
                connectedAtEpochMs: 2_500,
                lastHeartbeatAtEpochMs: 2_500,
                expiresAtEpochMs: Date.now() + 60_000,
                requestId,
            },
        },
    });

    await waitForQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    const entry = readOnlyEntry(queue);
    if (!entry) {
        throw new Error('Expected app inbox entry to remain in queue');
    }

    return entry;
}

async function processUpsertGroupMember(
    appInbox: AppGroupInboxService,
    reader: InboxQueueReader,
    queue: InMemoryQueueBox,
    groupId: string,
    principalId: string,
): Promise<ResourceEntry> {
    const requestId = `join-${principalId}-${groupId}`;
    const key = {
        topicId: 'app-inbox.group-state',
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
    };
    appInbox.processEntryNoWaiting<GroupMemberUpsertAppInboxPayload>({
        type: AppInboxType.GROUP_MEMBER_UPSERT,
        resourceId: requestId,
        contextId: key.contextId,
        senderId: principalId,
        data: {
            scope: SCOPE,
            groupId,
            principalId,
            request: {
                status: 'active',
                actorPrincipalId: principalId,
                requestId,
            },
        },
    });

    await waitForQueueEntryKey(queue, key);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    return requireQueueEntry(await queue.getItem(key));
}

async function processConnectGroupPresence(
    appInbox: AppGroupInboxService,
    reader: InboxQueueReader,
    queue: InMemoryQueueBox,
    groupId: string,
    principalId: string,
    sessionId: string,
): Promise<ResourceEntry> {
    const requestId = `connect-${sessionId}-${groupId}`;
    const key = {
        topicId: 'app-inbox.group-state',
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
    };
    appInbox.processEntryNoWaiting<GroupPresenceConnectAppInboxPayload>({
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: requestId,
        contextId: key.contextId,
        senderId: principalId,
        data: {
            scope: SCOPE,
            groupId,
            sessionId,
            request: {
                principalId,
                connectedAtEpochMs: 3_500,
                lastHeartbeatAtEpochMs: 3_500,
                expiresAtEpochMs: Date.now() + 60_000,
                actorPrincipalId: principalId,
                actorSessionId: sessionId,
                requestId,
            },
        },
    });

    await waitForQueueEntryKey(queue, key);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    return requireQueueEntry(await queue.getItem(key));
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}

function createPublisher(
    enqueueOutboxIfAbsent: (message: ALMessage) => Promise<unknown>,
) {
    return createWsStateSyncPublisher(
        { enqueueOutboxIfAbsent } as unknown as WsQueueBoxServerService,
        {
            serverId: 'test-server',
        },
    );
}

function firstEnqueuedMessage(
    enqueueOutboxIfAbsent: Readonly<{
        mock: Readonly<{
            calls: readonly (readonly unknown[])[];
        }>;
    }>,
): ALMessage {
    const message = enqueueOutboxIfAbsent.mock.calls[0]?.[0];
    if (message === undefined) {
        throw new Error('Expected at least one enqueued message');
    }

    return message as ALMessage;
}

async function waitForQueueEntry(queue: InMemoryQueueBox): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (readOnlyEntry(queue)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('Expected app inbox entry to be enqueued');
}

async function waitForQueueEntryKey(
    queue: InMemoryQueueBox,
    key: Key,
): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (await queue.getItem(key)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(`Expected app inbox entry to be enqueued: ${toKeyAsString(key)}`);
}

function requireQueueEntry(entry: ResourceEntry | undefined): ResourceEntry {
    if (!entry) {
        throw new Error('Expected app inbox entry to remain in queue');
    }

    return entry;
}

function readOnlyEntry(queue: InMemoryQueueBox): ResourceEntry | undefined {
    const data = (
        queue as unknown as {
            data: Map<string, ResourceEntry>;
        }
    ).data;

    return data.values().next().value;
}
