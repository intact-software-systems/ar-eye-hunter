import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';
import type { AuditStamp, GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
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
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
    SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC,
    SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
} from '@shared-server/rallar-system/services/AppInboxService.ts';
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
import {
    hashAuthSecret,
    type IssuedAuthSession,
    type PersistedAuthSession,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { toResultsDomain } from '@shared-server/postgres/resource-inbox/repository-utils.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { InMemoryGroupStateEventStore } from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import {
    ClientStateEventCollisionError,
    GroupStateEventCollisionError,
} from '@shared-server/postgres/rallar-system/PSqlStateEventRepository.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

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
            findBySessionId: async (sessionId) => {
                const issued = sessions.get(sessionId);
                return issued ? await toPersistedTestAuthSession(issued) : undefined;
            },
        },
    });
    TEST_AUTHORITIES.set(service, (input) => {
        const authority = toTestAuthority(input);
        sessions.set(authority.sessionId, authority);
        return authority;
    });
    return service;
}

async function toPersistedTestAuthSession(
    session: IssuedAuthSession,
): Promise<PersistedAuthSession> {
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await hashAuthSecret(session.accessToken),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs,
    };
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
            createAppInboxTestDatabase(queue, results),
            'server-12345678',
            SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
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
            createAppInboxTestDatabase(queue, results),
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
            createAppInboxTestDatabase(queue, results),
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
            createAppInboxTestDatabase(queue, results),
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
            createAppInboxTestDatabase(queue, results),
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
        expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.FAILED);
        expect(readOnlyEntry(queue)?.dequeueAudit.attempts).toBe(1);
    });

    it.each([
        [
            'client event',
            new ClientStateEventCollisionError({
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                principalId: 'alice',
                eventId: 'collision-event',
            }),
            'client-state-event-collision',
        ],
        [
            'group event',
            new GroupStateEventCollisionError({
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                groupId: 'collision-room',
                eventId: 'collision-event',
            }),
            'group-state-event-collision',
        ],
    ])('stores %s collision as terminal without queue retry', async (_label, error, code) => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new AppInboxService(
            reader,
            queue as never,
            results as never,
            createAppInboxTestDatabase(queue, results),
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
        const handler = vi.fn(() => Promise.reject(error));
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
        const pending = service.processEntryUntilCompletion({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: `terminal-${code}`,
            contextId: 'app:workspace:alice',
            data: { requestId: `terminal-${code}`, username: 'alice' },
        });

        await reader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );
        const result = await pending;

        expect(JSON.parse(result.left ?? '{}')).toMatchObject({ code, status: 409 });
        expect(handler).toHaveBeenCalledOnce();
        expect(readOnlyEntry(queue)?.status).toBe(EntityStatus.FAILED);
        expect(readOnlyEntry(queue)?.dequeueAudit.attempts).toBe(1);
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
    const activeStatuses = new Set<EntityStatus>([
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
    const audit = createAuditStamp();
    const snapshot: GroupSnapshot = {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            ...SCOPE,
            groupId,
            displayName: groupId,
            activeMemberCount: 1,
            ownerPrincipalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: audit,
            updated: audit,
        }),
        members: [
            {
                ...SCOPE,
                groupId,
                principalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
                role: 'owner',
                status: 'active',
                joined: audit,
                updated: audit,
                invitedByPrincipalId: null,
                invitationExpiresAtEpochMs: null,
                left: null,
                removed: null,
                banned: null,
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
        causalRevision: snapshot.causalRevision,
        occurredAtEpochMs: 1,
        requestId: 'create-group-request-1',
        actor: {
            kind: 'principal',
            principalId: snapshot.members[0].principalId,
        },
        reason: null,
        traceId: null,
        payload: {},
    };

    return {
        snapshot,
        event,
    };
}

function createAuditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: {
            kind: 'principal',
            principalId: '3e1be4ce-9a29-47bb-9d63-ef7752d31234',
        },
        reason: null,
        traceId: null,
        requestId: 'create-group-request-1',
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
