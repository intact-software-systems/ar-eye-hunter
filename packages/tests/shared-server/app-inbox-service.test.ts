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
    createGroupStateService as createProductionGroupStateService,
    GroupStateService,
    type GroupStateServiceDependencies,
    type GroupStateWritten,
    GroupWritten,
    type GroupJoinCodeWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { toResultsDomain } from '@shared-server/postgres/resource-inbox/repository-utils.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default',
};

const TEST_AUTHORITIES = new WeakMap<
    GroupStateService,
    (input: AppInboxEnqueueInput<unknown>) => IssuedAuthSession
>();

function createGroupStateService(
    dependencies: Omit<GroupStateServiceDependencies, 'authSessionRepository'>,
): GroupStateService {
    const sessions = new Map<string, IssuedAuthSession>();
    const service = createProductionGroupStateService({
        ...dependencies,
        authSessionRepository: {
            findBySessionId: (sessionId) => Promise.resolve(sessions.get(sessionId)),
        },
    });
    TEST_AUTHORITIES.set(service, (input) => {
        const authority = toTestAuthority(input);
        sessions.set(authority.sessionId, authority);
        return authority;
    });
    return service;
}

function toTestAuthority(input: AppInboxEnqueueInput<unknown>): IssuedAuthSession {
    const data = input.data as Readonly<Record<string, unknown>>;
    const request = data.request as Readonly<Record<string, unknown>>;
    const principalId = String(
        request.actorPrincipalId ??
        request.createdByPrincipalId ??
        request.principalId ??
        input.senderId ??
        'alice',
    );
    const sessionId = String(
        data.sessionId ?? request.actorSessionId ?? `${principalId}-session`,
    );
    return {
        clientId: principalId,
        sessionId,
        accessToken: `test-token:${principalId}:${sessionId}`,
        username: principalId,
        issuedAtEpochMs: 1,
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
    };
}

function testAuthorityFor<V>(
    service: AppGroupInboxService,
    input: AppInboxEnqueueInput<V>,
): IssuedAuthSession {
    const factory = TEST_AUTHORITIES.get(service.groupStateService);
    if (!factory) {
        throw new Error('Expected the test group state service to register authority');
    }
    return factory(input as AppInboxEnqueueInput<unknown>);
}

describe('AppInboxType', () => {
    it('does not expose server-produced RTC topology work', () => {
        expect(AppInboxType).not.toHaveProperty('RTC_TOPOLOGY_RECOMPUTE');
    });
});

describe('AppInboxService', () => {
    it('uses the stored JSON wire identity for sparse member upserts and rejects unsafe values without invoking accessors', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const handler = vi.fn((data: GroupMemberUpsertAppInboxPayload) =>
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
        service.onStateMessage(AppInboxType.GROUP_MEMBER_UPSERT, handler);
        const sparse = {
            type: AppInboxType.GROUP_MEMBER_UPSERT,
            resourceId: 'sparse-member-upsert',
            contextId: 'ar-eye-hunter:default:group-1',
            senderId: 'alice',
            data: {
                scope: SCOPE,
                groupId: 'group-1',
                principalId: 'alice',
                request: {
                    status: 'active' as const,
                    role: undefined,
                    actorPrincipalId: 'alice',
                    requestId: 'sparse-member-upsert',
                },
            },
        } satisfies AppInboxEnqueueInput<GroupMemberUpsertAppInboxPayload>;

        const pending = service.processEntryUntilCompletion(sparse);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const first = await pending;

        await expect(service.processEntryUntilCompletion({
            ...sparse,
            data: {
                principalId: 'alice',
                request: {
                    requestId: 'sparse-member-upsert',
                    actorPrincipalId: 'alice',
                    status: 'active',
                },
                groupId: 'group-1',
                scope: { workspaceId: 'default', applicationId: 'ar-eye-hunter' },
            },
        })).resolves.toEqual(first);
        await expect(service.processEntryUntilCompletion({
            ...sparse,
            data: {
                ...sparse.data,
                request: { ...sparse.data.request, status: 'left' },
            },
        })).rejects.toMatchObject({ status: 409 });
        expect(Object.hasOwn(sparse.data.request, 'role')).toBe(true);
        expect(sparse.data.request.role).toBeUndefined();

        let getterCalls = 0;
        const unsafe = {
            ...sparse,
            resourceId: 'unsafe-member-upsert',
            data: {
                ...sparse.data,
                request: { ...sparse.data.request },
            },
        };
        Object.defineProperty(unsafe.data.request, 'role', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'member';
            },
        });
        await expect(service.processEntryUntilCompletion(unsafe)).rejects.toThrow(
            /JSON wire|accessor/u,
        );
        expect(getterCalls).toBe(0);
        await expect(service.processEntryUntilCompletion({
            ...sparse,
            resourceId: 'unsafe-array',
            data: { ...sparse.data, unsafe: [undefined] },
        } as never)).rejects.toThrow(/JSON wire|array/u);
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        for (const [resourceId, value] of [
            ['unsafe-function', () => undefined],
            ['unsafe-bigint', 1n],
            ['unsafe-cycle', cycle],
            ['unsafe-nonfinite', Number.POSITIVE_INFINITY],
        ] as const) {
            await expect(service.processEntryUntilCompletion({
                ...sparse,
                resourceId,
                data: { ...sparse.data, unsafe: value },
            } as never)).rejects.toThrow(/JSON wire/u);
        }
        expect(handler).toHaveBeenCalledOnce();
    });

    it('preserves an own __proto__ JSON key across first write, reordered replay, and conflict identity', async () => {
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
        const firstData = JSON.parse(
            '{"principalId":"alice","request":{"requestId":"proto-command","metadata":{"alpha":1,"__proto__":{"flag":"first"}}}}',
        ) as Readonly<Record<string, unknown>>;
        const input = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'proto-command',
            contextId: 'app:workspace:alice',
            senderId: 'alice',
            data: firstData,
        } as const;

        const pending = service.processEntryUntilCompletion(input);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const first = await pending;
        const reorderedData = JSON.parse(
            '{"request":{"metadata":{"__proto__":{"flag":"first"},"alpha":1},"requestId":"proto-command"},"principalId":"alice"}',
        ) as Readonly<Record<string, unknown>>;

        await expect(service.processEntryUntilCompletion({
            ...input,
            data: reorderedData,
        })).resolves.toEqual(first);
        const changedData = JSON.parse(
            '{"principalId":"alice","request":{"requestId":"proto-command","metadata":{"alpha":1,"__proto__":{"flag":"changed"}}}}',
        ) as Readonly<Record<string, unknown>>;
        await expect(service.processEntryUntilCompletion({
            ...input,
            data: changedData,
        })).rejects.toMatchObject({ status: 409 });

        expect(handler).toHaveBeenCalledOnce();
        const handled = handler.mock.calls[0]?.[0] as {
            request: { metadata: Record<string, unknown> };
        };
        const metadata = handled.request.metadata;
        expect(Object.hasOwn(metadata, '__proto__')).toBe(true);
        expect(metadata.__proto__).toEqual({ flag: 'first' });
        expect([Object.prototype, null]).toContain(Object.getPrototypeOf(metadata));
        expect(({} as Record<string, unknown>).flag).toBeUndefined();
        const stored = readEnqueuedData<{
            request: { metadata: Record<string, unknown> };
        }>(readOnlyEntry(queue)!);
        expect(Object.hasOwn(stored.request.metadata, '__proto__')).toBe(true);
        expect(stored.request.metadata.__proto__).toEqual({ flag: 'first' });
    });

    it('rejects unsafe first-request JSON wire values before leaving any queue row', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const handler = vi.fn(() => Promise.resolve({ accepted: true }));
        const service = new AppInboxService(
            reader,
            queue as never,
            results as never,
            'server-12345678',
            SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
        let getterCalls = 0;
        const accessor: Record<string, unknown> = {};
        Object.defineProperty(accessor, 'value', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'unsafe';
            },
        });
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const unsafeValues = [
            accessor,
            cycle,
            1n,
            () => undefined,
            Number.NaN,
            [undefined],
        ] as const;

        for (const [index, unsafe] of unsafeValues.entries()) {
            await expect(service.processEntryUntilCompletion({
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: `unsafe-first-${index}`,
                contextId: 'app:workspace:alice',
                senderId: 'alice',
                data: { unsafe },
            } as never)).rejects.toThrow(/JSON wire/u);
            expect(await readEntries(queue)).toHaveLength(0);
        }
        expect(getterCalls).toBe(0);
        expect(handler).not.toHaveBeenCalled();
    });

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
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            'server-12345678',
            (event) => timingEvents.push(event),
            {
                phaseTiming: true,
                waitMaxElapsedMsecs: 5_000,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0,
            },
        );

        const input = {
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
                    kind: 'room' as const,
                    joinMode: 'open' as const,
                    createdByPrincipalId: written.snapshot.members[0].principalId,
                    requestId: written.event.requestId,
                },
            },
        };
        const resultPromise = service.processAuthenticatedEntryUntilCompletion<
            GroupCreateAppInboxPayload,
            GroupStateWritten
        >(input, testAuthorityFor(service, input));

        await waitForQueueEntry(queue);
        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        const result = await resultPromise;
        expect(result.right).toEqual(stateWritten);
        expect(groupStateService.createGroup).toHaveBeenCalledOnce();
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();

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

    it('rejects every inherited unauthenticated group enqueue variant before insertion', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const groupStateService = createGroupStateServiceStub({});
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            'server-1',
        );
        const input: AppInboxEnqueueInput<GroupCreateAppInboxPayload> = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'unauthenticated-group-create',
            contextId: 'app:workspace:group',
            senderId: 'mallory',
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'group',
                    displayName: 'Group',
                    kind: 'room',
                    createdByPrincipalId: 'mallory',
                    requestId: 'unauthenticated-group-create',
                },
            },
        };

        expect(() => service.processEntryNoWaiting(input)).toThrow(
            /authenticated group mutation authority/i,
        );
        expect(() => service.processEntryNoWaitingIf(input, () => true)).toThrow(
            /authenticated group mutation authority/i,
        );
        await expect(service.processEntryUntilCompletion(input)).rejects.toThrow(
            /authenticated group mutation authority/i,
        );
        await expect(
            service.processEntryUntilCompletionIf(input, () => true),
        ).rejects.toThrow(/authenticated group mutation authority/i);

        expect(readOnlyEntry(queue)).toBeUndefined();
        expect(groupStateService.prepareMutation).not.toHaveBeenCalled();
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
        const service = new AppGroupInboxService(
            reader,
            queue as never,
            results as never,
            groupStateService,
            'server-12345678',
            undefined,
            undefined,
        );

        await processCreateGroup(
            service,
            reader,
            'group-without-event',
            'create-group-without-event',
        );

        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
    });

    it('records app-inbox wait fallback timing when completion is not observed', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const timingEvents: RallarTimingEvent[] = [];
        const _publisher = {
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

        const input = {
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
        };
        const result = await service.processAuthenticatedEntryUntilCompletion<
            GroupUpdateAppInboxPayload,
            GroupStateWritten
        >(input, testAuthorityFor(service, input));

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
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();

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
            GroupMutationReceipt
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
                    generationId: 'bob-generation-1',
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
            GroupMutationReceipt
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
                    generationId: 'bob-generation-1',
                    lastHeartbeatAtEpochMs: 3_000,
                    expiresAtEpochMs: Date.now() + 60_000,
                    actorPrincipalId: 'bob',
                    requestId: 'heartbeat-bob-mutation-room',
                },
            },
        });
        const disconnected = await processAppInbox<
            GroupPresenceDisconnectAppInboxPayload,
            GroupMutationReceipt
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
                    generationId: 'bob-generation-1',
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
        // Presence is a separate concurrency domain; request responses may
        // permissively carry the older valid summary until outbox convergence.
        expect(connected.right?.outcome).toBe('applied');
        expect(heartbeat.right?.outcome).toBe('applied');
        expect(disconnected.right?.outcome).toBe('applied');
        expect(updated.right?.result.right?.event?.eventType).toBe('group-updated');
        expect(member.right?.result.right?.event?.eventType).toBe('member-joined');
        expect(connected.right?.event.kind === 'group' &&
            connected.right.event.event.eventType).toBe(
            'session-connected',
        );
        expect(heartbeat.right?.event.kind === 'group' &&
            heartbeat.right.event.event.eventType).toBe(
            'session-heartbeat',
        );
        expect(disconnected.right?.event.kind === 'group' &&
            disconnected.right.event.event.eventType).toBe(
            'session-disconnected',
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();

        const repository = new GroupStateRepository(runtimeRepository, {
            events: eventStore,
        });
        expect(await repository.findPresenceSession({
            ...SCOPE,
            groupId: 'mutation-room',
            sessionId: 'bob-session',
        })).toMatchObject({
            generationId: 'bob-generation-1',
            lastHeartbeatAtEpochMs: 3_000,
            disconnectedAtEpochMs: 4_000,
        });
        const eventTypes = (
            await repository.listEvents({
                ...SCOPE,
                groupId: 'mutation-room',
            })
        ).map((event) => event.eventType);
        expect(eventTypes).toHaveLength(6);
        expect(eventTypes).toEqual(
            expect.arrayContaining([
                'group-created',
                'group-updated',
                'member-joined',
                'session-connected',
                'session-heartbeat',
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
                    displayName: 'Replay Room',
                    actorPrincipalId: 'alice',
                    requestId: 'update-replay-room',
                },
            },
        });

        expect(writtenSnapshot(replayed).group.displayName).toBe('Replay Room');
        expect(replayed.right?.result.right?.event?.eventType).toBe(
            'group-updated',
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
    });

    it('keeps websocket and expiry maintenance off the public group inbox surface', () => {
        expect(AppGroupInboxService.prototype).not.toHaveProperty(
            'processPresenceDisconnectsBySessionId',
        );
        expect(AppGroupInboxService.prototype).not.toHaveProperty(
            'processExpiredPresenceSessions',
        );
        expect(AppGroupInboxService.prototype).not.toHaveProperty(
            'processExpiredPresenceSessionsNoWaiting',
        );
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

        expect(result.left).toContain('Group not found: missing-room');
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
            expect.objectContaining({
                version: 1,
                principalId: 'alice',
                sessionId: 'alice-session',
            }),
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
        );
        expect(groupStateService.acceptGroupInvite).toHaveBeenCalledWith(
            SCOPE,
            'invite-room',
            {
                actorPrincipalId: 'member-1',
                actorSessionId: 'member-session',
                requestId: 'invite-accept-1',
            },
            expect.objectContaining({
                version: 1,
                principalId: 'member-1',
                sessionId: 'member-session',
            }),
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
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
            expect.objectContaining({
                version: 1,
                principalId: 'owner-1',
                sessionId: 'owner-session',
            }),
        );
        expect(publisher.publishGroupSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishGroupEvent).not.toHaveBeenCalled();
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
            'server-12345678',
            (event) => timingEvents.push(event),
            {
                waitMaxElapsedMsecs: 1,
                waitRetryIntervalMsecs: 1,
                waitMaxRetryIntervalMsecs: 1,
                waitJitterRatio: 0,
            },
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
    const service = {
        prepareMutation: vi.fn(async (descriptor, authority) => ({
            authorityProof: {
                version: 1 as const,
                principalId: authority.clientId,
                sessionId: authority.sessionId,
                sessionIssuedAtEpochMs: authority.issuedAtEpochMs,
                sessionExpiresAtEpochMs: authority.expiresAtEpochMs,
                commandMac: '0'.repeat(64),
            },
            causalToken: 'test-causal-token',
            queueResourceId: descriptor.request.requestId,
        })),
        listSnapshots: vi.fn(),
        listSnapshotsPage: vi.fn(),
        readSnapshot: vi.fn(),
        readStateRevision: vi.fn(),
        readCausalRevision: vi.fn(),
        listEvents: vi.fn(),
        listEventPage: vi.fn(),
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
        ...overrides,
    } as unknown as GroupStateService;
    TEST_AUTHORITIES.set(service, toTestAuthority);
    return service;
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
    const resultPromise = service.processAuthenticatedEntryUntilCompletion<V, R>(
        input,
        testAuthorityFor(service, input),
    );
    const queue = service.resourceInbox as unknown as InMemoryQueueBox;
    let settled = false;
    void resultPromise.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    for (let i = 0; i < 20 && !settled; i += 1) {
        if ((await readEntries(queue)).some((entry) => entry.status === EntityStatus.NEW)) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (settled) {
        return await resultPromise;
    }
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
    const resultPromise = service.processAuthenticatedEntryUntilCompletion<V>(
        input,
        testAuthorityFor(service, input),
    );
    await waitForQueueEntryStatus(queue, EntityStatus.NEW);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createResilience(),
    );
    await resultPromise;

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
