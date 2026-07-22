import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
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
import {
    AuthSessionRepository,
    type IssuedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
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
const CLIENT_INBOX_AUTHORITIES = new WeakMap<
    AppClientInboxService,
    (principalId: string, sessionId?: string) => Promise<IssuedAuthSession>
>();

describe('state sync publish failure characterization', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('client app inbox commits an outbox intent without invoking direct publication', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const enqueueOutboxIfAbsent = vi.fn(async () => {
            throw new Error('client snapshot enqueue unavailable');
        });
        const { appInbox, reader, queue, results, outboxEntries, clientEventStore } =
            createClientAppInbox(
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
        const durableRepository = new ClientStateRepository(runtimeRepository, {
            events: clientEventStore,
        });
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
        expect(await clientMutationOutboxRecords(runtimeRepository)).toEqual([]);
        expect([...outboxEntries.values()]).toHaveLength(2);
        expect([...outboxEntries.values()].every((entry) => entry.typeId === 'WS_OUTBOX')).toBe(
            true,
        );
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
        const { appInbox, reader, queue, results, outboxEntries } = createClientAppInbox(
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
            expect(await clientMutationOutboxRecords(runtimeRepository)).toEqual([]);
            expect([...outboxEntries.values()]).toHaveLength(2);
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
        createAppInboxTestDatabase(queue, results),
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
    _publisher: ReturnType<typeof createPublisher>,
    _now: number,
): Readonly<{
    appInbox: AppClientInboxService;
    reader: InboxQueueReader;
    queue: TestResourceInbox;
    results: TestResourceInboxResults;
    outboxEntries: ReadonlyMap<string, ResourceEntry>;
    clientEventStore: ReturnType<typeof createAppInboxTestDatabase>['clientEventStore'];
}> {
    const queue = new TestResourceInbox();
    const reader = new InboxQueueReader(queue);
    const results = new TestResourceInboxResults();
    const clientsRepository = new ClientStateRepository(runtimeRepository);
    const database = createAppInboxTestDatabase(queue, results, {
        runtimeRepository,
    });
    const authSessions = new AuthSessionRepository(runtimeRepository);
    const appInbox = new AppClientInboxService(
        reader,
        queue as never,
        results as never,
        database,
        createCachedClientStateService({
            durable: createClientStateService({
                runtimeRepository,
                createClientStateEventStore: () => database.clientEventStore,
                serviceId: 'state-service',
            }),
            cache: createClientStateSnapshotReadThroughCache({
                clientsRepository,
            }),
        }),
        'state-service',
    );
    CLIENT_INBOX_AUTHORITIES.set(appInbox, async (principalId, requestedSessionId) => {
        const sessionId = requestedSessionId ?? `${principalId}-session`;
        const existing = await authSessions.findBySessionId(sessionId);
        if (existing) return existing;
        const authority = {
            clientId: principalId,
            sessionId,
            accessToken: `test-token:${principalId}:${sessionId}`,
            username: principalId,
            issuedAtEpochMs: 1,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        } satisfies IssuedAuthSession;
        await authSessions.putSession(authority);
        return authority;
    });

    return {
        appInbox,
        reader,
        queue,
        results,
        outboxEntries: database.outboxEntries,
        clientEventStore: database.clientEventStore,
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
    const input: AppInboxEnqueueInput<ClientPrincipalUpsertAppInboxPayload> = {
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
    };
    const resultPromise = appInbox.processAuthenticatedEntryUntilCompletion(
        input,
        await clientAuthority(appInbox, principalId),
    );

    const queued = await waitForNewQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );
    await resultPromise;

    return requireQueueEntry(await queue.getItem(queued.key));
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
    const input: AppInboxEnqueueInput<ClientSessionConnectAppInboxPayload> = {
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
    };
    const resultPromise = appInbox.processAuthenticatedEntryUntilCompletion(
        input,
        await clientAuthority(appInbox, principalId, sessionId),
    );

    const queued = await waitForNewQueueEntry(queue);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );
    await resultPromise;

    return requireQueueEntry(await queue.getItem(queued.key));
}

async function clientAuthority(
    appInbox: AppClientInboxService,
    principalId: string,
    sessionId?: string,
): Promise<IssuedAuthSession> {
    const issue = CLIENT_INBOX_AUTHORITIES.get(appInbox);
    if (!issue) {
        throw new Error('Expected client app inbox authority issuer');
    }
    return await issue(principalId, sessionId);
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
