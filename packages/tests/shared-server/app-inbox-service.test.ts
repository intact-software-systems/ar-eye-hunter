import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
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
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    AppInboxService,
    AppGroupInboxService,
    type AppInboxEnqueueInput,
    AppInboxType,
    type GroupCreateAppInboxPayload,
    type GroupExpiredPresenceSessionsAppInboxPayload,
    type GroupInviteAcceptAppInboxPayload,
    type GroupInviteCreateAppInboxPayload,
    type GroupInviteRevokeAppInboxPayload,
    type GroupJoinCodeRotateAppInboxPayload,
    type GroupJoinAppInboxPayload,
    type GroupMemberBanAppInboxPayload,
    type GroupMemberRemoveAppInboxPayload,
    type GroupMemberRoleSetAppInboxPayload,
    type GroupMemberUnbanAppInboxPayload,
    type GroupMemberUpsertAppInboxPayload,
    type GroupOwnershipTransferAppInboxPayload,
    type GroupPresenceConnectAppInboxPayload,
    type GroupPresenceDisconnectAppInboxPayload,
    type GroupPresenceHeartbeatAppInboxPayload,
    type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
    createGroupStateService,
    GroupStateService,
    type GroupStateWritten,
    GroupWritten,
    type GroupJoinCodeWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { toResultsDomain } from '@shared-server/postgres/resource-inbox/repository-utils.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/services/client-state-service.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
};

describe('AppInboxType', () => {
    it('does not expose server-produced RTC topology work', () => {
        expect(AppInboxType).not.toHaveProperty('RTC_TOPOLOGY_RECOMPUTE');
    });
});

describe('AppInboxService', () => {
    it('rejects different semantic content behind the same real queue id while replaying reordered equal content', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const handler = vi.fn((data: Readonly<Record<string, unknown>>) =>
            Promise.resolve({ accepted: data })
        );
        const service = new AppInboxService(
            reader,
            queue as never,
            results as never,
            'server-12345678',
            SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            undefined,
            {
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0,
            },
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
        const firstInput = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'same-public-request',
            contextId: 'app:workspace:alice',
            senderId: 'alice',
            data: {
                principalId: 'alice',
                request: {
                    requestId: 'same-public-request',
                    metadata: { alpha: 1, beta: 2 },
                },
            },
        } as const;
        const firstPromise = service.processEntryUntilCompletion(firstInput);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        const first = await firstPromise;
        const reordered = await service.processEntryUntilCompletion({
            senderId: 'alice',
            contextId: 'app:workspace:alice',
            resourceId: 'same-public-request',
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            data: {
                request: {
                    metadata: { beta: 2, alpha: 1 },
                    requestId: 'same-public-request',
                },
                principalId: 'alice',
            },
        });

        expect(reordered).toEqual(first);
        await expect(service.processEntryUntilCompletion({
            ...firstInput,
            data: {
                ...firstInput.data,
                request: {
                    ...firstInput.data.request,
                    metadata: { alpha: 1, beta: 3 },
                },
            },
        })).rejects.toMatchObject({
            name: 'AppInboxIdempotencyConflictError',
            code: 'app-inbox-idempotency-conflict',
            status: 409,
        });
        expect(handler).toHaveBeenCalledOnce();
    });

    it('stores client idempotency conflict as terminal without queue retry', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new AppInboxService(
            reader,
            queue as never,
            results as never,
            'server-12345678',
            SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
            undefined,
            {
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0,
            },
        );
        const handler = vi.fn(() => Promise.reject(
            new ClientMutationIdempotencyConflictError(
                'same-request',
                `sha256:${'a'.repeat(64)}`,
                `sha256:${'b'.repeat(64)}`,
            ),
        ));
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
        const pending = service.processEntryUntilCompletion({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'same-request',
            contextId: 'app:workspace:alice',
            data: { requestId: 'same-request', username: 'alice' },
        });

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const result = await pending;

        expect(JSON.parse(result.left ?? '{}')).toMatchObject({
            code: 'client-mutation-idempotency-conflict',
            status: 409,
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.COMPLETED);
        expect(readOnlyEntry(queue)?.dequeueAudit.attempts).toBe(1);
    });

    it('processes createGroup through the inbox and stores a readable result with bounded queue keys', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const written = createGroupWritten('groupcreate-long-1234');
        const stateWritten = createGroupStateWritten(written);
        const timingEvents: RallarTimingEvent[] = [];
        const groupStateService = createGroupStateServiceStub({
            createGroup: vi.fn(async () => stateWritten),
        });
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const groupMutationOutboxPublisher = {
            enqueueForGroupSnapshot: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
            (event) => timingEvents.push(event),
            {
                phaseTiming: true,
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0,
            },
            groupMutationOutboxPublisher,
        );

        const resultPromise = service.processEntryUntilCompletion<
            GroupCreateAppInboxPayload,
            GroupStateWritten
        >({
            type: AppInboxType.GROUP_CREATE,
            resourceId: crypto.randomUUID(),
            contextId:
                'ar-eye-hunter:default:groupcreate-long-1234-that-exceeds-the-column',
            senderId: crypto.randomUUID(),
            data: {
                scope: SCOPE,
                request: {
                    groupId: written.snapshot.group.groupId,
                    displayName: written.snapshot.group.displayName,
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: written.snapshot.members[0].principalId,
                    requestId: written.event.requestId,
                },
            },
        });

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        const result = await resultPromise;
        expect(result.right).toEqual(stateWritten);
        expect(groupStateService.createGroup).toHaveBeenCalledOnce();
        // TEMP(Task 4): remove only after every group producer derives
        // canonical SHA-256 internally before retry, persists the identical
        // receipt/outbox digest, proves reordered replay and semantic conflict,
        // accepts no caller hash, and writes every intent transactionally.
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledWith(
            written.snapshot,
            'server-12345678',
        );
        expect(publisher.publishGroupEvent).toHaveBeenCalledWith(
            written.event,
            'server-12345678',
        );
        expect(groupMutationOutboxPublisher.enqueueForGroupSnapshot)
            .toHaveBeenCalledWith(written.snapshot);
        expect(
            publisher.publishGroupEvent.mock.invocationCallOrder[0],
        ).toBeLessThan(
            groupMutationOutboxPublisher.enqueueForGroupSnapshot.mock
                .invocationCallOrder[0]!,
        );

        const entry = readOnlyEntry(queue);
        expect(entry?.status).toBe(EntityStatus.COMPLETED);
        expect(entry?.key.resourceId.length).toBeLessThanOrEqual(36);
        expect(entry?.key.topicId.length).toBeLessThanOrEqual(36);
        expect(entry?.key.contextId.length).toBeLessThanOrEqual(35);
        expect(entry?.audit.createdBy.length).toBeLessThanOrEqual(16);
        expect(timingEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    component: 'app-inbox',
                    operation: 'processEntryUntilCompletion',
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
                expect.objectContaining({
                    component: 'app-inbox-handler',
                    operation: AppInboxType.GROUP_CREATE,
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
                expect.objectContaining({
                    component: 'app-inbox-phase',
                    operation: 'enqueue',
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
                expect.objectContaining({
                    component: 'app-inbox-phase',
                    operation: 'wait-completion',
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
                expect.objectContaining({
                    component: 'app-inbox-phase',
                    operation: 'read-result',
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
                expect.objectContaining({
                    component: 'app-inbox-phase',
                    operation: 'handler-action',
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
                expect.objectContaining({
                    component: 'app-inbox-phase',
                    operation: 'write-result',
                    status: 'ok',
                    serviceId: 'server-12345678',
                }),
            ]),
        );
    });

    it('does not publish state sync or derived outbox work without a mutation event', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const written = createGroupWritten('group-without-event');
        const groupStateService = createGroupStateServiceStub({
            createGroup: vi.fn(async () =>
                createGroupStateWritten({ ...written, event: undefined })
            ),
        });
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const groupMutationOutboxPublisher = {
            enqueueForGroupSnapshot: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
            undefined,
            undefined,
            groupMutationOutboxPublisher,
        );

        await processCreateGroup(
            service,
            reader,
            'group-without-event',
            'create-group-without-event',
        );

        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
        expect(groupMutationOutboxPublisher.enqueueForGroupSnapshot)
            .not.toHaveBeenCalled();
    });

    it('records app-inbox wait fallback timing when completion is not observed', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const timingEvents: RallarTimingEvent[] = [];
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateServiceStub({}),
            publisher,
            'server-12345678',
            (event) => timingEvents.push(event),
            {
                phaseTiming: true,
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0,
            },
        );

        const result = await service.processEntryUntilCompletion<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >({
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-timeout-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:timeout-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'timeout-room',
                request: {
                    displayName: 'Timeout Room',
                    actorPrincipalId: 'alice',
                    requestId: 'update-timeout-room',
                },
            },
        });

        expect(result.left).toBe('App inbox entry not completed');
        expect(timingEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    component: 'app-inbox-phase',
                    operation: 'wait-fallback',
                    status: 'ok',
                    details: expect.objectContaining({
                        type: AppInboxType.GROUP_UPDATE,
                        resourceId: 'update-timeout-room',
                    }),
                }),
            ]),
        );
    });

    it('returns an error result when the same group is created with a different idempotency key', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryGroupStateEventStore();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateService({
                runtimeRepository,
                createGroupStateEventStore: () => eventStore,
                syncPublisher: publisher,
                now: () => 1_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        const first = await processCreateGroup(
            service,
            reader,
            'duplicate-room',
            'create-duplicate-room-1',
        );
        const second = await processCreateGroup(
            service,
            reader,
            'duplicate-room',
            'create-duplicate-room-2',
        );

        expect(first.right?.status).toBe('created');
        expect(first.right?.result.right?.snapshot.group).toMatchObject({
            ...SCOPE,
            groupId: 'duplicate-room',
            snapshotVersion: 1,
        });
        expect(second.right?.status).toBe('error');
        expect(second.right?.result.left).toBe(
            'Group already exists: duplicate-room',
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(1);

        const repository = new GroupStateRepository(runtimeRepository, {
            events: eventStore,
        });
        expect(
            await repository.listEvents({
                ...SCOPE,
                groupId: 'duplicate-room',
            }),
        ).toHaveLength(1);
    });

    it('processes update, member, and presence mutations through the inbox', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryGroupStateEventStore();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateService({
                runtimeRepository,
                createGroupStateEventStore: () => eventStore,
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        await processCreateGroup(
            service,
            reader,
            'mutation-room',
            'create-mutation-room',
        );
        const updated = await processAppInbox<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-mutation-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:mutation-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'mutation-room',
                request: {
                    displayName: 'Mutation Room',
                    actorPrincipalId: 'alice',
                    requestId: 'update-mutation-room',
                },
            },
        });
        const member = await processAppInbox<
            GroupMemberUpsertAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: 'join-bob-mutation-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:mutation-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'mutation-room',
                principalId: 'bob',
                request: {
                    status: 'active',
                    actorPrincipalId: 'alice',
                    requestId: 'join-bob-mutation-room',
                },
            },
        });
        const connected = await processAppInbox<
            GroupPresenceConnectAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: 'connect-bob-mutation-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:mutation-room`,
            senderId: 'bob',
            data: {
                scope: SCOPE,
                groupId: 'mutation-room',
                sessionId: 'bob-session',
                request: {
                    principalId: 'bob',
                    connectedAtEpochMs: 2_000,
                    lastHeartbeatAtEpochMs: 2_000,
                    expiresAtEpochMs: Date.now() + 60_000,
                    actorPrincipalId: 'bob',
                    requestId: 'connect-bob-mutation-room',
                },
            },
        });
        const heartbeat = await processAppInbox<
            GroupPresenceHeartbeatAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
            resourceId: 'heartbeat-bob-mutation-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:mutation-room`,
            senderId: 'bob',
            data: {
                scope: SCOPE,
                groupId: 'mutation-room',
                sessionId: 'bob-session',
                request: {
                    principalId: 'bob',
                    lastHeartbeatAtEpochMs: 3_000,
                    expiresAtEpochMs: Date.now() + 60_000,
                    actorPrincipalId: 'bob',
                    requestId: 'heartbeat-bob-mutation-room',
                },
            },
        });
        const disconnected = await processAppInbox<
            GroupPresenceDisconnectAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
            resourceId: 'disconnect-bob-mutation-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:mutation-room`,
            senderId: 'bob',
            data: {
                scope: SCOPE,
                groupId: 'mutation-room',
                sessionId: 'bob-session',
                request: {
                    principalId: 'bob',
                    disconnectedAtEpochMs: 4_000,
                    actorPrincipalId: 'bob',
                    requestId: 'disconnect-bob-mutation-room',
                },
            },
        });

        expect(writtenSnapshot(updated).group.displayName).toBe('Mutation Room');
        expect(
            writtenSnapshot(member)
                .members.map((entry) => entry.principalId)
                .sort(),
        ).toEqual(['alice', 'bob']);
        expect(writtenSnapshot(connected).activeSessions).toHaveLength(1);
        expect(writtenSnapshot(heartbeat).activeSessions[0]).toMatchObject({
            sessionId: 'bob-session',
            lastHeartbeatAtEpochMs: 3_000,
        });
        expect(writtenSnapshot(disconnected).activeSessions).toHaveLength(0);
        expect(updated.right?.result.right?.event?.eventType).toBe('group-updated');
        expect(member.right?.result.right?.event?.eventType).toBe('member-joined');
        expect(connected.right?.result.right?.event?.eventType).toBe(
            'session-connected',
        );
        expect(heartbeat.right?.result.right?.event).toBeUndefined();
        expect(disconnected.right?.result.right?.event?.eventType).toBe(
            'session-disconnected',
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(5);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(5);

        const repository = new GroupStateRepository(runtimeRepository, {
            events: eventStore,
        });
        const eventTypes = (
            await repository.listEvents({
                ...SCOPE,
                groupId: 'mutation-room',
            })
        ).map((event) => event.eventType);
        expect(eventTypes).toHaveLength(5);
        expect(eventTypes).toEqual(
            expect.arrayContaining([
                'group-created',
                'group-updated',
                'member-joined',
                'session-connected',
                'session-disconnected',
            ]),
        );
    }, 30_000);

    it('publishes stored idempotent mutation results when the service replays a request', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateService({
                runtimeRepository,
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        await processCreateGroup(
            service,
            reader,
            'replay-room',
            'create-replay-room',
        );
        await processAppInbox<GroupUpdateAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_UPDATE,
                resourceId: 'update-replay-room-queue-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:replay-room`,
                senderId: 'alice',
                data: {
                    scope: SCOPE,
                    groupId: 'replay-room',
                    request: {
                        displayName: 'Replay Room',
                        actorPrincipalId: 'alice',
                        requestId: 'update-replay-room',
                    },
                },
            },
        );
        publisher.publishGroupSnapshot.mockClear();
        publisher.publishGroupEvent.mockClear();

        const replayed = await processAppInbox<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-replay-room-queue-2',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:replay-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'replay-room',
                request: {
                    displayName: 'Different payload ignored by idempotency',
                    actorPrincipalId: 'alice',
                    requestId: 'update-replay-room',
                },
            },
        });

        expect(writtenSnapshot(replayed).group.displayName).toBe('Replay Room');
        expect(replayed.right?.result.right?.event?.eventType).toBe(
            'group-updated',
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(1);
    });

    it('processes websocket group presence cleanup through the inbox', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateService({
                runtimeRepository,
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        await processCreateGroup(
            service,
            reader,
            'ws-cleanup-room',
            'create-ws-cleanup-room',
        );
        await processAppInbox<
            GroupPresenceConnectAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_PRESENCE_CONNECT,
            resourceId: 'connect-alice-ws-cleanup-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:ws-cleanup-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'ws-cleanup-room',
                sessionId: 'alice-ws-session',
                request: {
                    principalId: 'alice',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-ws-session',
                    expiresAtEpochMs: Date.now() + 60_000,
                    requestId: 'connect-alice-ws-cleanup-room',
                },
            },
        });
        vi.mocked(publisher.publishGroupSnapshot).mockClear();
        vi.mocked(publisher.publishGroupEvent).mockClear();

        const disconnected = await processAppInboxMethod(reader, () =>
            service.processPresenceDisconnectsBySessionId('alice-ws-session', {
                actorSessionId: 'alice-ws-session',
                reason: 'socket-closed',
            })
        );

        expect(disconnected.right).toHaveLength(1);
        expect(disconnected.right?.[0].result.right?.snapshot.activeSessions).toHaveLength(0);
        expect(disconnected.right?.[0].result.right?.event?.eventType).toBe(
            'session-disconnected',
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(1);
    });

    it('processes expired group presence sessions through the inbox and publishes written mutations', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        let serviceNow = 2_000;
        const expiresAtEpochMs = Date.now() - 1_000;
        const groupStateService = createGroupStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => serviceNow,
            serviceId: 'server-12345678',
        });
        await groupStateService.createGroup(SCOPE, {
            groupId: 'expired-presence-room',
            displayName: 'expired-presence-room',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'alice',
            requestId: 'seed-expired-presence-room',
        });
        await groupStateService.connectPresenceSession(
            SCOPE,
            'expired-presence-room',
            'alice-session',
            {
                principalId: 'alice',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                expiresAtEpochMs,
                requestId: 'seed-expired-presence-session',
            },
        );
        serviceNow = expiresAtEpochMs + 1;

        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        const expired = await processAppInboxMethod(reader, () =>
            service.processExpiredPresenceSessions(serviceNow)
        );

        expect(expired.right).toHaveLength(1);
        expect(expired.right?.[0].result.right?.event).toMatchObject({
            eventType: 'session-disconnected',
            reason: 'expired',
        });
        expect(expired.right?.[0].result.right?.snapshot.activeSessions).toEqual([]);
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(1);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(1);
    });

    it('keeps at most one active no-wait group expiry entry across timestamps', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const groupStateService = createGroupStateServiceStub({
            expireExpiredPresenceSessions: vi.fn(async () => []),
        });
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        service.processExpiredPresenceSessionsNoWaiting(60_000);
        service.processExpiredPresenceSessionsNoWaiting(120_000);

        await waitForQueueEntryCount(queue, 1);
        const entries = await readEntries(queue);

        expect(activeEntries(entries)).toHaveLength(1);
        expect(entries[0].key.resourceId).toBe('expire-group-presence');
        expect(
            readEnqueuedData<GroupExpiredPresenceSessionsAppInboxPayload>(
                entries[0],
            ).atEpochMs,
        ).toBe(60_000);
        expect(groupStateService.expireExpiredPresenceSessions).not.toHaveBeenCalled();
    });

    it('keeps at most one active waiting group expiry entry across timestamps', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const expireExpiredPresenceSessions = vi.fn(async () => []);
        const groupStateService = createGroupStateServiceStub({
            expireExpiredPresenceSessions,
        });
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        const first = service.processExpiredPresenceSessions(60_000);
        const second = service.processExpiredPresenceSessions(120_000);

        await waitForQueueEntryCount(queue, 1);
        const entries = await readEntries(queue);

        expect(activeEntries(entries)).toHaveLength(1);
        expect(entries[0].key.resourceId).toBe('expire-group-presence');
        expect(
            readEnqueuedData<GroupExpiredPresenceSessionsAppInboxPayload>(
                entries[0],
            ).atEpochMs,
        ).toBe(60_000);

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        await expect(first).resolves.toMatchObject({ right: [] });
        await expect(second).resolves.toMatchObject({ right: [] });
        expect(expireExpiredPresenceSessions).toHaveBeenCalledTimes(1);
        expect(expireExpiredPresenceSessions).toHaveBeenLastCalledWith(60_000);
    });

    it('does not replace reserved or retry group expiry entries', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const groupStateService = createGroupStateServiceStub({
            expireExpiredPresenceSessions: vi.fn(async () => []),
        });
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        service.processExpiredPresenceSessionsNoWaiting(60_000);
        await waitForQueueEntryCount(queue, 1);
        let [entry] = await readEntries(queue);
        await queue.releaseEntries([entry], EntityStatus.RESERVED);

        service.processExpiredPresenceSessionsNoWaiting(120_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.status).toBe(EntityStatus.RESERVED);
        expect(
            readEnqueuedData<GroupExpiredPresenceSessionsAppInboxPayload>(entry)
                .atEpochMs,
        ).toBe(60_000);

        await queue.releaseEntries([entry], EntityStatus.RETRY);

        service.processExpiredPresenceSessionsNoWaiting(180_000);
        await new Promise((resolve) => setTimeout(resolve, 0));
        [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(
            readEnqueuedData<GroupExpiredPresenceSessionsAppInboxPayload>(entry)
                .atEpochMs,
        ).toBe(60_000);
    });

    it('skips active group expiry entries and replaces completed ones', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const expireExpiredPresenceSessions = vi.fn(async () => []);
        const groupStateService = createGroupStateServiceStub({
            expireExpiredPresenceSessions,
        });
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        service.processExpiredPresenceSessionsNoWaiting(60_000);
        service.processExpiredPresenceSessionsNoWaiting(120_000);

        await waitForQueueEntryCount(queue, 1);
        let [entry] = await readEntries(queue);
        expect(activeEntries([entry])).toHaveLength(1);
        expect(entry.key.resourceId).toBe('expire-group-presence');
        expect(
            readEnqueuedData<GroupExpiredPresenceSessionsAppInboxPayload>(entry)
                .atEpochMs,
        ).toBe(60_000);

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect(expireExpiredPresenceSessions).toHaveBeenCalledTimes(1);
        expect(expireExpiredPresenceSessions).toHaveBeenLastCalledWith(60_000);

        service.processExpiredPresenceSessionsNoWaiting(120_000);

        await waitForQueueEntryStatus(queue, EntityStatus.NEW);
        [entry] = await readEntries(queue);
        expect(entry.status).toBe(EntityStatus.NEW);
        expect(
            readEnqueuedData<GroupExpiredPresenceSessionsAppInboxPayload>(entry)
                .atEpochMs,
        ).toBe(120_000);

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        expect(expireExpiredPresenceSessions).toHaveBeenCalledTimes(2);
        expect(expireExpiredPresenceSessions).toHaveBeenLastCalledWith(120_000);
    });

    it('returns a left result when an app inbox mutation handler fails', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateService({
                runtimeRepository: new FakeRuntimeStateRepository(),
                syncPublisher: publisher,
                now: () => 2_000,
                serviceId: 'server-12345678',
            }),
            publisher,
            'server-12345678',
        );

        const result = await processAppInbox<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-missing-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:missing-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'missing-room',
                request: {
                    displayName: 'Missing Room',
                    actorPrincipalId: 'alice',
                    requestId: 'update-missing-room',
                },
            },
        });

        expect(result.left).toBe('Group not found: missing-room');
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
    });

    it('processes explicit group join through the inbox and publishes the mutation', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const written = createGroupWritten('join-room');
        const stateWritten = createGroupStateWritten(written);
        const groupStateService = createGroupStateServiceStub({
            joinGroup: vi.fn(async () => stateWritten),
        });
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        const result = await processAppInbox<
            GroupJoinAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_JOIN,
            resourceId: 'join-request-1',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:join-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'join-room',
                request: {
                    inviteToken: 'invite-1',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'join-request-1',
                },
            },
        });

        expect(result.right).toEqual(stateWritten);
        expect(groupStateService.joinGroup).toHaveBeenCalledWith(
            SCOPE,
            'join-room',
            {
                inviteToken: 'invite-1',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'join-request-1',
            },
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledWith(
            written.snapshot,
            'server-12345678',
        );
        expect(publisher.publishGroupEvent).toHaveBeenCalledWith(
            written.event,
            'server-12345678',
        );
    });

    it('processes group invite workflows through the inbox', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const written = createGroupWritten('invite-room');
        const stateWritten = createGroupStateWritten(written);
        const groupStateService = createGroupStateServiceStub({
            createGroupInvite: vi.fn(async () => stateWritten),
            revokeGroupInvite: vi.fn(async () => stateWritten),
            acceptGroupInvite: vi.fn(async () => stateWritten),
        });
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        await processAppInbox<GroupInviteCreateAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_INVITE_CREATE,
                resourceId: 'invite-create-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:invite-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'invite-room',
                    principalId: 'member-1',
                    request: {
                        invitationExpiresAtEpochMs: 2_000,
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'invite-create-1',
                    },
                },
            },
        );
        await processAppInbox<GroupInviteRevokeAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_INVITE_REVOKE,
                resourceId: 'invite-revoke-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:invite-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'invite-room',
                    principalId: 'member-1',
                    request: {
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'invite-revoke-1',
                    },
                },
            },
        );
        await processAppInbox<GroupInviteAcceptAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_INVITE_ACCEPT,
                resourceId: 'invite-accept-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:invite-room`,
                senderId: 'member-1',
                data: {
                    scope: SCOPE,
                    groupId: 'invite-room',
                    request: {
                        actorPrincipalId: 'member-1',
                        actorSessionId: 'member-session',
                        requestId: 'invite-accept-1',
                    },
                },
            },
        );

        expect(groupStateService.createGroupInvite).toHaveBeenCalledWith(
            SCOPE,
            'invite-room',
            'member-1',
            {
                invitationExpiresAtEpochMs: 2_000,
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'invite-create-1',
            },
        );
        expect(groupStateService.revokeGroupInvite).toHaveBeenCalledWith(
            SCOPE,
            'invite-room',
            'member-1',
            {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'invite-revoke-1',
            },
        );
        expect(groupStateService.acceptGroupInvite).toHaveBeenCalledWith(
            SCOPE,
            'invite-room',
            {
                actorPrincipalId: 'member-1',
                actorSessionId: 'member-session',
                requestId: 'invite-accept-1',
            },
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(3);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(3);
    });

    it('processes group join-code rotation through the inbox and publishes the mutation', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const written = createGroupWritten('code-room');
        const codeWritten: GroupJoinCodeWritten = {
            status: 'ok',
            result: Either.ofRight({
                joinCode: 'code-1',
                expiresAtEpochMs: 2_000,
                snapshot: written.snapshot,
                event: written.event,
            }),
        };
        const groupStateService = createGroupStateServiceStub({
            rotateGroupJoinCode: vi.fn(async () => codeWritten),
        });
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        const result = await processAppInbox<
            GroupJoinCodeRotateAppInboxPayload,
            GroupJoinCodeWritten
        >(service, reader, {
            type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
            resourceId: 'rotate-code-1',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:code-room`,
            senderId: 'owner-1',
            data: {
                scope: SCOPE,
                groupId: 'code-room',
                request: {
                    joinCode: 'code-1',
                    expiresAtEpochMs: 2_000,
                    actorPrincipalId: 'owner-1',
                    actorSessionId: 'owner-session',
                    requestId: 'rotate-code-1',
                },
            },
        });

        expect(result.right).toEqual(codeWritten);
        expect(groupStateService.rotateGroupJoinCode).toHaveBeenCalledWith(
            SCOPE,
            'code-room',
            {
                joinCode: 'code-1',
                expiresAtEpochMs: 2_000,
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'rotate-code-1',
            },
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledWith(
            written.snapshot,
            'server-12345678',
        );
        expect(publisher.publishGroupEvent).toHaveBeenCalledWith(
            written.event,
            'server-12345678',
        );
    });

    it('processes membership governance mutations through the inbox and publishes the mutations', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const written = createGroupStateWritten(createGroupWritten('governed-room'));
        const groupStateService = createGroupStateServiceStub({
            removeGroupMember: vi.fn(async () => written),
            banGroupMember: vi.fn(async () => written),
            unbanGroupMember: vi.fn(async () => written),
            setGroupMemberRole: vi.fn(async () => written),
            transferGroupOwnership: vi.fn(async () => written),
        });
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            publisher,
            'server-12345678',
        );

        await processAppInbox<GroupMemberRemoveAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_MEMBER_REMOVE,
                resourceId: 'remove-member-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:governed-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'governed-room',
                    principalId: 'member-1',
                    request: {
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'remove-member-1',
                    },
                },
            },
        );
        await processAppInbox<GroupMemberBanAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_MEMBER_BAN,
                resourceId: 'ban-member-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:governed-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'governed-room',
                    principalId: 'member-1',
                    request: {
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'ban-member-1',
                    },
                },
            },
        );
        await processAppInbox<GroupMemberUnbanAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_MEMBER_UNBAN,
                resourceId: 'unban-member-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:governed-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'governed-room',
                    principalId: 'member-1',
                    request: {
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'unban-member-1',
                    },
                },
            },
        );
        await processAppInbox<GroupMemberRoleSetAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_MEMBER_ROLE_SET,
                resourceId: 'role-member-1',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:governed-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'governed-room',
                    principalId: 'member-1',
                    request: {
                        role: 'admin',
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'role-member-1',
                    },
                },
            },
        );
        await processAppInbox<GroupOwnershipTransferAppInboxPayload, GroupStateWritten>(
            service,
            reader,
            {
                type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
                resourceId: 'transfer-owner',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:governed-room`,
                senderId: 'owner-1',
                data: {
                    scope: SCOPE,
                    groupId: 'governed-room',
                    request: {
                        newOwnerPrincipalId: 'member-1',
                        actorPrincipalId: 'owner-1',
                        actorSessionId: 'owner-session',
                        requestId: 'transfer-owner',
                    },
                },
            },
        );

        expect(groupStateService.removeGroupMember).toHaveBeenCalledWith(
            SCOPE,
            'governed-room',
            'member-1',
            {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'remove-member-1',
            },
        );
        expect(groupStateService.banGroupMember).toHaveBeenCalledWith(
            SCOPE,
            'governed-room',
            'member-1',
            {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'ban-member-1',
            },
        );
        expect(groupStateService.unbanGroupMember).toHaveBeenCalledWith(
            SCOPE,
            'governed-room',
            'member-1',
            {
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'unban-member-1',
            },
        );
        expect(groupStateService.setGroupMemberRole).toHaveBeenCalledWith(
            SCOPE,
            'governed-room',
            'member-1',
            {
                role: 'admin',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'role-member-1',
            },
        );
        expect(groupStateService.transferGroupOwnership).toHaveBeenCalledWith(
            SCOPE,
            'governed-room',
            {
                newOwnerPrincipalId: 'member-1',
                actorPrincipalId: 'owner-1',
                actorSessionId: 'owner-session',
                requestId: 'transfer-owner',
            },
        );
        expect(publisher.publishGroupSnapshot).toHaveBeenCalledTimes(5);
        expect(publisher.publishGroupEvent).toHaveBeenCalledTimes(5);
    });

    it('preserves policy denial details in failed app inbox results', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateServiceStub({
                updateGroup: vi.fn(async () => {
                    throw new GroupPolicyDeniedError({
                        allowed: false,
                        code: 'group-archived',
                        message: 'Group is archived.',
                        details: { groupId: 'room-1' },
                    });
                }),
            }),
            publisher,
            'server-12345678',
        );

        const result = await processAppInbox<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(service, reader, {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-archived-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:room-1`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'room-1',
                request: {
                    displayName: 'Archived Room',
                    actorPrincipalId: 'alice',
                    requestId: 'update-archived-room',
                },
            },
        });

        expect(JSON.parse(result.left ?? '{}')).toEqual({
            error: 'Forbidden: Group is archived.',
            code: 'group-archived',
            message: 'Group is archived.',
            details: { groupId: 'room-1' },
        });
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
    });

    it('keeps retryable app inbox handler failures in the queue without a failed result', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const timingEvents: RallarTimingEvent[] = [];
        const publisher = {
            publishClientSnapshot: vi.fn(async () => undefined),
            publishClientEvent: vi.fn(async () => undefined),
            publishGroupSnapshot: vi.fn(async () => undefined),
            publishGroupEvent: vi.fn(async () => undefined),
        };
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            createGroupStateServiceStub({
                updateGroup: vi.fn(async () => {
                    throw new Error('Transient group update unavailable');
                }),
            }),
            publisher,
            'server-12345678',
            (event) => timingEvents.push(event),
        );

        const entry = await processAppInboxNoWaiting<
            GroupUpdateAppInboxPayload
        >(service, reader, queue, {
            type: AppInboxType.GROUP_UPDATE,
            resourceId: 'update-retryable-room',
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:retryable-room`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'retryable-room',
                request: {
                    displayName: 'Retryable Room',
                    actorPrincipalId: 'alice',
                    requestId: 'update-retryable-room',
                },
            },
        });

        expect(entry.status).toBe(EntityStatus.RETRY);
        expect(entry.dequeueAudit.attempts).toBe(1);
        expect(await results.findByKey(entry.key)).toBeUndefined();
        expect(timingEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    component: 'app-inbox-handler',
                    operation: 'queue-retry',
                    status: 'ok',
                    details: expect.objectContaining({
                        attempts: 1,
                        queueAgeMs: expect.any(Number),
                        type: AppInboxType.GROUP_UPDATE,
                        resourceId: 'update-retryable-room',
                    }),
                }),
            ]),
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
    });

    it('maps resource_inbox_results rows from ris columns into queue entries', () => {
        const entry = toResultsDomain({
            ris_row_id: 123n,
            ris_resource_id: 'request-1',
            ris_topic_id: 'app-inbox.group-state',
            ris_resource: JSON.stringify({ ok: true }),
            ris_type_id: 'APP_INBOX',
            ris_status: EntityStatus.COMPLETED,
            fk_ext_bank_id: 'group-create',
            system_date: '2026-05-20',
            created_by: 'server-1',
            created_ts: '2026-05-20T10:00:00.000',
            expire_ts: '2026-05-20T10:05:00.000',
        });

        expect(entry.key).toEqual({
            topicId: 'app-inbox.group-state',
            resourceId: 'request-1',
            contextId: 'group-create',
        });
        expect(entry.resource).toBe(JSON.stringify({ ok: true }));
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(entry.dequeueAudit.attempts).toBe(0);
        expect(entry.db?.id).toBe('123');
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

function createGroupStateServiceStub(
    overrides: Partial<GroupStateService>,
): GroupStateService {
    return {
        listSnapshots: vi.fn(),
        readSnapshot: vi.fn(),
        listEvents: vi.fn(),
        createGroup: vi.fn(),
        updateGroup: vi.fn(),
        createGroupInvite: vi.fn(),
        revokeGroupInvite: vi.fn(),
        acceptGroupInvite: vi.fn(),
        joinGroup: vi.fn(),
        rotateGroupJoinCode: vi.fn(),
        removeGroupMember: vi.fn(),
        banGroupMember: vi.fn(),
        unbanGroupMember: vi.fn(),
        setGroupMemberRole: vi.fn(),
        transferGroupOwnership: vi.fn(),
        upsertMember: vi.fn(),
        connectPresenceSession: vi.fn(),
        heartbeatPresenceSession: vi.fn(),
        disconnectPresenceSession: vi.fn(),
        disconnectPresenceSessionsBySessionId: vi.fn(),
        disconnectPresenceSessionsBySessionIdWritten: vi.fn(),
        expireExpiredPresenceSessions: vi.fn(),
        ...overrides,
    } as unknown as GroupStateService;
}

async function processCreateGroup(
    service: AppGroupInboxService,
    reader: InboxQueueReader,
    groupId: string,
    requestId: string,
): Promise<Either<string, GroupStateWritten>> {
    return await processAppInbox<GroupCreateAppInboxPayload, GroupStateWritten>(
        service,
        reader,
        {
            type: AppInboxType.GROUP_CREATE,
            resourceId: requestId,
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:${groupId}`,
            senderId: 'alice',
            data: {
                scope: SCOPE,
                request: {
                    groupId,
                    displayName: groupId,
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'alice',
                    requestId,
                },
            },
        },
    );
}

async function processAppInbox<V, R>(
    service: AppGroupInboxService,
    reader: InboxQueueReader,
    input: AppInboxEnqueueInput<V>,
): Promise<Either<string, R>> {
    const resultPromise = service.processEntryUntilCompletion<V, R>(input);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    return await resultPromise;
}

async function processAppInboxMethod<R>(
    reader: InboxQueueReader,
    run: () => Promise<R>,
): Promise<R> {
    const resultPromise = run();
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );

    return await resultPromise;
}

async function processAppInboxNoWaiting<V>(
    service: AppGroupInboxService,
    reader: InboxQueueReader,
    queue: InMemoryQueueBox,
    input: AppInboxEnqueueInput<V>,
): Promise<ResourceEntry> {
    service.processEntryNoWaiting<V>(input);
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

async function waitForQueueEntry(queue: InMemoryQueueBox): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (readOnlyEntry(queue)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('Expected app inbox entry to be enqueued');
}

async function waitForQueueEntryCount(
    queue: InMemoryQueueBox,
    count: number,
): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if ((await readEntries(queue)).length >= count) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(`Expected at least ${count} app inbox entries`);
}

async function waitForQueueEntryStatus(
    queue: InMemoryQueueBox,
    status: EntityStatus,
): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if ((await readEntries(queue)).some((entry) => entry.status === status)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    throw new Error(`Expected app inbox entry with status ${status}`);
}

async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key)),
    );

    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

function activeEntries(entries: ResourceEntry[]): ResourceEntry[] {
    const activeStatuses = new Set([
        EntityStatus.NEW,
        EntityStatus.RESERVED,
        EntityStatus.RETRY,
    ]);

    return entries.filter((entry) => activeStatuses.has(entry.status));
}

function readEnqueuedData<V>(entry: ResourceEntry): V {
    const message = JSON.parse(entry.resource) as {
        payload: {
            resource: string;
        };
    };
    const enqueue = JSON.parse(message.payload.resource) as {
        data: V;
    };

    return enqueue.data;
}

function writtenSnapshot(
    result: Either<string, GroupStateWritten>,
): GroupSnapshot {
    const snapshot = result.right?.result.right?.snapshot;
    if (!snapshot) {
        throw new Error(
            result.left ??
            result.right?.result.left ??
            'Expected group state written snapshot',
        );
    }

    return snapshot;
}

function createGroupStateWritten(written: GroupWritten): GroupStateWritten {
    return {
        status: 'created',
        result: Either.ofRight(written),
    };
}

function createGroupWritten(groupId: string): GroupWritten {
    const snapshot: GroupSnapshot = {
        group: {
            ...SCOPE,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
                byServiceId: 'server-12345678',
                requestId: 'create-group-request-1',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
                byServiceId: 'server-12345678',
                requestId: 'create-group-request-1',
            },
        },
        members: [
            {
                ...SCOPE,
                groupId,
                principalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
                role: 'owner',
                status: 'active',
                joined: {
                    atEpochMs: 1,
                    byPrincipalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
                    byServiceId: 'server-12345678',
                    requestId: 'create-group-request-1',
                },
                updated: {
                    atEpochMs: 1,
                    byPrincipalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
                    byServiceId: 'server-12345678',
                    requestId: 'create-group-request-1',
                },
            },
        ],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0,
    };
    const event: GroupEvent = {
        ...SCOPE,
        groupId,
        eventId: 'event-1',
        eventType: 'group-created',
        snapshotVersion: snapshot.group.snapshotVersion,
        occurredAtEpochMs: 1,
        requestId: 'create-group-request-1',
        actor: {
            principalId: snapshot.members[0].principalId,
            serviceId: 'server-12345678',
        },
    };

    return {
        snapshot,
        event,
    };
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

function readOnlyEntry(queue: InMemoryQueueBox): ResourceEntry | undefined {
    const data = (
        queue as unknown as {
            data: Map<string, ResourceEntry>;
        }
    ).data;

    return data.values().next().value;
}
