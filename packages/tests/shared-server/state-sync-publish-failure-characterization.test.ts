import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
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
import {
    STATE_MUTATION_OUTBOX_NAMESPACE,
    StateMutationOutboxRepository,
} from '@shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import {
    AppClientInboxService,
    type ClientPrincipalUpsertAppInboxPayload,
    type ClientSessionConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import {
    AppGroupInboxService,
    type AppInboxEnqueueInput,
    AppInboxType,
    type GroupCreateAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { createGroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { createWsStateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { createCachedClientStateService } from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import { createClientStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import { StateMutationOutboxWork } from '@shared-server/rallar-system/services/StateMutationOutboxWork.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

const GROUP_INBOX_AUTHORITIES = new WeakMap<
    AppGroupInboxService,
    (principalId: string, sessionId?: string) => IssuedAuthSession
>();

describe('state sync publish failure characterization', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('group app inbox commits state and durable intents without inline publication', async () => {
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
        expect(enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        expect(await groupMutationOutboxRecords(runtimeRepository)).toEqual([
            expect.objectContaining({
                kind: 'group',
                commandId: 'create-room-1',
                effects: ['group-state-sync', 'group-presence-summary'],
                delivery: { status: 'pending' },
            }),
        ]);
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
        });
    });

    it('drains a committed group intent after worker restart', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async () => {
            throw new Error('legacy publisher must stay unused');
        });
        const { appInbox, reader, queue, results } = createGroupAppInbox(
            runtimeRepository,
            createPublisher(enqueueOutboxIfAbsent),
            1_500,
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
        const stateSyncPublisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const summaryPublisher = {
            enqueueForGroupSnapshot: vi.fn(async () => ({
                effectiveSnapshotRevision: 1,
            })),
        };
        const repository = new GroupStateRepository(runtimeRepository);
        const restartedWork = new StateMutationOutboxWork({
            repository: new StateMutationOutboxRepository(runtimeRepository),
            readClientSnapshot: async () => undefined,
            readGroupSnapshot: (ref) => repository.readSnapshot(ref),
            stateSyncPublisher,
            groupPresenceSummaryPublisher: summaryPublisher,
        });

        expect(await restartedWork.drainPending()).toMatchObject({ delivered: 1 });
        expect(summaryPublisher.enqueueForGroupSnapshot).toHaveBeenCalledOnce();
        expect(stateSyncPublisher.publishGroupSnapshot).toHaveBeenCalledOnce();
        expect(enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        expect((await groupMutationOutboxRecords(runtimeRepository))[0])
            .toMatchObject({ delivery: { status: 'delivered' } });
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(await results.findByKey(entry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
        });
    });

    it('client app inbox commits an outbox intent without invoking direct publication', async () => {
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
        expect(enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        expect(await clientMutationOutboxRecords(runtimeRepository)).toEqual([
            expect.objectContaining({
                kind: 'client',
                commandId: 'upsert-client-alice',
                effects: ['client-state-sync'],
                delivery: { status: 'pending' },
            }),
        ]);
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
        });
    });

    it('client session connect remains independent of the legacy publisher route', async () => {
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
            expect(enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(await clientMutationOutboxRecords(runtimeRepository)).toEqual([
                expect.objectContaining({
                    kind: 'client',
                    commandId: 'connect-client-session-alice',
                    effects: ['client-state-sync'],
                    delivery: { status: 'pending' },
                }),
            ]);
            expect(entry.status).toBe(EntityStatus.COMPLETED);
            expect(entry.dequeueAudit.attempts).toBe(1);
            expect(await results.findByKey(entry.key)).toMatchObject({
                status: EntityStatus.COMPLETED,
            });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('group presence commits independently of inline state-sync routing', async () => {
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

            const groupRepository = new GroupStateRepository(runtimeRepository);
            expect(await groupRepository.findPresenceSession({
                ...groupRef,
                sessionId: 'session-alice',
            })).toMatchObject({
                generationId: 'generation-session-alice',
                principalId: 'alice',
            });
            expect((await groupRepository.readSnapshot(groupRef))?.activeSessions)
                .toEqual([]);
            expect(enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(await groupMutationOutboxRecords(runtimeRepository)).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        commandId: 'connect-session-alice-room-no-route',
                        effects: ['group-state-sync', 'group-presence-summary'],
                        delivery: { status: 'pending' },
                    }),
                ]),
            );
            expect(entry.status).toBe(EntityStatus.COMPLETED);
            expect(entry.dequeueAudit.attempts).toBe(1);
            expect(await results.findByKey(entry.key)).toMatchObject({
                status: EntityStatus.COMPLETED,
            });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('group event publication failures are isolated behind the durable drainer', async () => {
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

        expect(enqueuedMessages).toEqual([]);
        expect(
            await new GroupStateRepository(runtimeRepository).readSnapshot(groupRef),
        ).toBeDefined();
        expect(findGroupStateSnapshotByRef(groupRef)).toBeDefined();
        expect(await groupMutationOutboxRecords(runtimeRepository)).toEqual([
            expect.objectContaining({
                commandId: 'create-room-2',
                delivery: { status: 'pending' },
            }),
        ]);
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
        });
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
): Readonly<{
    appInbox: AppGroupInboxService;
    reader: InboxQueueReader;
    queue: TestResourceInbox;
    results: TestResourceInboxResults;
}> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const groupsRepository = new GroupStateRepository(runtimeRepository);
    const sessions = new Map<string, IssuedAuthSession>();
    const appInbox = new AppGroupInboxService(
        reader,
        queue as never,
        results as never,
        createCachedGroupStateService({
            durable: createGroupStateService({
                runtimeRepository,
                authSessionRepository: {
                    findBySessionId: (sessionId) =>
                        Promise.resolve(sessions.get(sessionId)),
                },
                syncPublisher: publisher,
                now: () => now,
                serviceId: 'state-service',
            }),
            cache: createGroupStateSnapshotReadThroughCache({
                groupsRepository,
            }),
        }),
        'state-service',
    );
    GROUP_INBOX_AUTHORITIES.set(appInbox, (principalId, requestedSessionId) => {
        const sessionId = requestedSessionId ?? `${principalId}-session`;
        const authority = {
            clientId: principalId,
            sessionId,
            accessToken: `test-token:${principalId}:${sessionId}`,
            username: principalId,
            issuedAtEpochMs: 1,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        } satisfies IssuedAuthSession;
        sessions.set(sessionId, authority);
        return authority;
    });

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
    const clientsRepository = new ClientStateRepository(runtimeRepository);
    const appInbox = new AppClientInboxService(
        reader,
        queue as never,
        results as never,
        createCachedClientStateService({
            durable: createClientStateService({
                runtimeRepository,
                syncPublisher: publisher,
                now: () => now,
                serviceId: 'state-service',
            }),
            cache: createClientStateSnapshotReadThroughCache({
                clientsRepository,
            }),
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
    const input: AppInboxEnqueueInput<GroupCreateAppInboxPayload> = {
        type: AppInboxType.GROUP_CREATE,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: 'alice',
        data: {
            scope: SCOPE,
            request: {
                groupId,
                displayName: groupId === 'room-1' ? 'Room 1' : 'Room 2',
                kind: 'room' as const,
                joinMode: 'open' as const,
                createdByPrincipalId: 'alice',
                requestId,
            },
        },
    };
    const resultPromise = appInbox.processAuthenticatedEntryUntilCompletion<
        GroupCreateAppInboxPayload
    >(input, groupAuthority(appInbox, 'alice'));

    const queued = await waitForNewQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );
    await resultPromise;

    const entry = await queue.getItem(queued.key);
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
                generationId: `generation-${sessionId}`,
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
    const input: AppInboxEnqueueInput<GroupMemberUpsertAppInboxPayload> = {
        type: AppInboxType.GROUP_MEMBER_UPSERT,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
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
    };
    const resultPromise = appInbox.processAuthenticatedEntryUntilCompletion<
        GroupMemberUpsertAppInboxPayload
    >(input, groupAuthority(appInbox, principalId));

    const queued = await waitForNewQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );
    await resultPromise;

    return requireQueueEntry(await queue.getItem(queued.key));
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
    const input = {
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
        senderId: principalId,
        data: {
            scope: SCOPE,
            groupId,
            sessionId,
            request: {
                principalId,
                generationId: `generation-${sessionId}`,
                connectedAtEpochMs: 3_500,
                lastHeartbeatAtEpochMs: 3_500,
                expiresAtEpochMs: Date.now() + 60_000,
                actorPrincipalId: principalId,
                actorSessionId: sessionId,
                requestId,
            },
        },
    };
    const resultPromise = appInbox.processAuthenticatedEntryUntilCompletion<
        GroupPresenceConnectAppInboxPayload
    >(input, groupAuthority(appInbox, principalId, sessionId));

    const queued = await waitForNewQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );
    await resultPromise;

    return requireQueueEntry(await queue.getItem(queued.key));
}

function groupAuthority(
    appInbox: AppGroupInboxService,
    principalId: string,
    sessionId?: string,
): IssuedAuthSession {
    const issue = GROUP_INBOX_AUTHORITIES.get(appInbox);
    if (!issue) {
        throw new Error('Expected group app inbox authority issuer');
    }
    return issue(principalId, sessionId);
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

async function clientMutationOutboxRecords(
    runtimeRepository: FakeRuntimeStateRepository,
): Promise<readonly Record<string, unknown>[]> {
    return (await runtimeRepository.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE))
        .map((entry) => JSON.parse(entry.value) as Record<string, unknown>)
        .filter((record) => record.kind === 'client');
}

async function groupMutationOutboxRecords(
    runtimeRepository: FakeRuntimeStateRepository,
): Promise<readonly Record<string, unknown>[]> {
    return (await runtimeRepository.findAllEntries(STATE_MUTATION_OUTBOX_NAMESPACE))
        .map((entry) => JSON.parse(entry.value) as Record<string, unknown>)
        .filter((record) => record.kind === 'group');
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

async function waitForNewQueueEntry(
    queue: InMemoryQueueBox,
): Promise<ResourceEntry> {
    for (let i = 0; i < 20; i += 1) {
        const entry = [...(
            queue as unknown as { data: Map<string, ResourceEntry> }
        ).data.values()].find((candidate) => candidate.status === EntityStatus.NEW);
        if (entry) {
            return entry;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Expected a new authenticated group inbox entry');
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
