import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType, type AppInboxEnqueueInput, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '@shared-server/rallar-system/app-inbox/app-inbox-persistence-ports.ts';
import { encodeAppInboxCommand } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import { CLIENT_STATE_APP_INBOX_TOPIC, GROUP_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/app-inbox/app-inbox-topics.ts';
import type { AppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import { AppInboxHandlerRegistry } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-registry.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import type { GroupMemberUpsertAppInboxPayload } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { ClientStateEventCollisionError } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import { GroupStateEventCollisionError } from '@shared-server/rallar-system/state-events/group-state-event-store.ts';

import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation.ts';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, isExpiredResourceEntry, toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAppInboxTestDatabase } from '../test-support/app-inbox-test-database.ts';

const SCOPE: StateScope = {
    applicationId: 'ar-eye-hunter',
    workspaceId: 'default'
};

describe('AppInbox command lifecycle', () => {
    it('uses the configured domain topic when an enqueue omits topicId', async () => {
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: new InboxQueueReader(queue),
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC
            }
        );

        const entry = await service.enqueue({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'domain-default-topic',
            contextId: 'client-1',
            data: { requestId: 'domain-default-topic' }
        });

        expect(entry.key.topicId).toBe(CLIENT_STATE_APP_INBOX_TOPIC);
    });

    it('wakes only the strict reservation winner and never creates a second queue identity', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        let wakeRequests = 0;
        const wakeOwningQueue = () => {
            wakeRequests += 1;
        };
        const service = new MaterializedTestAppInboxService(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                wakeOwningQueue,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        service.onStateMessage(AppInboxType.CRDT_SNAPSHOT_COMPACT, async (data) => data);
        const requestId = `strict-request-${'r'.repeat(113)}`;
        const contextId = `strict-context-${'c'.repeat(113)}`;
        let materializations = 0;
        const materialize = async () => {
            materializations += 1;
            return {
                type: AppInboxType.CRDT_SNAPSHOT_COMPACT,
                topicId: AppInboxType.CRDT_SNAPSHOT_COMPACT,
                resourceId: requestId,
                contextId,
                senderId: 'admin',
                data: { status: 'winner' }
            } as const;
        };
        const placeholder = {
            type: AppInboxType.CRDT_SNAPSHOT_COMPACT,
            topicId: AppInboxType.CRDT_SNAPSHOT_COMPACT,
            resourceId: requestId,
            contextId,
            senderId: 'admin',
            data: null
        } as const;

        const winner = await service.beginMaterializedReservation({ placeholder, materialize });
        const loser = await service.beginMaterializedReservation({ placeholder, materialize });

        expect(winner.winner).toBe(true);
        expect(loser.winner).toBe(false);
        expect(materializations).toBe(1);
        expect(wakeRequests).toBe(1);
        expect(await queue.getAllKeys()).toEqual([
            {
                topicId: AppInboxType.CRDT_SNAPSHOT_COMPACT,
                resourceId: requestId,
                contextId
            }
        ]);

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(Promise.all([winner.result, loser.result])).resolves.toEqual([
            Either.ofRight({ status: 'winner' }),
            Either.ofRight({ status: 'winner' })
        ]);
        expect(await queue.getAllKeys()).toHaveLength(1);
    });

    it('decodes a completed persisted result exactly once at the AppInbox boundary', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, async () => ({
            status: 'stored'
        }));
        const decodedValues: JsonWireValue[] = [];
        const decodeResult = (value: JsonWireValue) => {
            decodedValues.push(value);
            if (
                typeof value !== 'object' ||
                value === null ||
                !('status' in value) ||
                value.status !== 'stored'
            ) {
                throw new TypeError('Unexpected stored result');
            }
            return { accepted: true } as const;
        };
        const pending = service.enqueueAndWaitForResult(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: CLIENT_STATE_APP_INBOX_TOPIC,
                resourceId: 'decoded-result',
                contextId: 'client-1',
                data: { requestId: 'decoded-result' }
            },
            decodeResult
        );

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toEqual(Either.ofRight({ accepted: true }));
        expect(decodedValues).toEqual([{ status: 'stored' }]);
    });

    it('uses one dedicated telemetry-clock sample for retry fallback ages', async () => {
        const queue = new TestResourceInbox();
        const reader = new CapturingInboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        let businessClockReads = 0;
        let timingClockReads = 0;
        const businessNowEpochMs = () => {
            businessClockReads += 1;
            return 9_000;
        };
        const timingNowEpochMs = () => {
            timingClockReads += 1;
            return 2_000;
        };
        const timing: RallarTimingEvent[] = [];
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                timing: (event) => timing.push(event),
                options: { nowEpochMs: businessNowEpochMs, timingNowEpochMs }
            }
        );
        service.onStateMessage(
            AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            async () => await Promise.reject(new Error('retryable test failure'))
        );
        const enqueue = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            topicId: CLIENT_STATE_APP_INBOX_TOPIC,
            resourceId: 'retry-telemetry-clock',
            contextId: 'client-1',
            data: { requestId: 'retry-telemetry-clock' }
        } as const;
        const message = newALUntargetedMessage(
            'server-12345678',
            newALRoute(enqueue.topicId, enqueue.contextId, enqueue.resourceId),
            enqueue.type,
            enqueue
        );
        const queued = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.APP_INBOX);
        const entry = {
            ...queued,
            audit: {
                ...queued.audit,
                createdTs: Temporal.Instant.fromEpochMilliseconds(1_000)
                    .toZonedDateTimeISO('UTC')
                    .toPlainDateTime()
            },
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(1_500)
            }
        };

        await expect(reader.invoke(message, entry)).rejects.toThrow('retryable test failure');

        expect(businessClockReads).toBe(0);
        expect(timingClockReads).toBe(1);
        expect(timing).toContainEqual(
            expect.objectContaining({
                operation: 'queue-retry',
                details: expect.objectContaining({ queueAgeMs: 1_000, dueAgeMs: 500 })
            })
        );
    });

    it('uses exact stored JSON wire identity and rejects unsafe accessors', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const handledPayloads: JsonWireValue[] = [];
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, async (data) => {
            handledPayloads.push(data);
            return { accepted: data };
        });
        const currentCommand = {
            scope: SCOPE,
            groupId: 'group-1',
            principalId: 'alice',
            request: {
                status: 'active' as const,
                actorPrincipalId: 'alice',
                requestId: 'sparse-member-upsert'
            }
        } satisfies GroupMemberUpsertAppInboxPayload;
        const current = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'sparse-member-upsert',
            contextId: 'ar-eye-hunter:default:group-1',
            senderId: 'alice',
            data: encodeAppInboxCommand(
                currentCommand,
                'Group member upsert test command'
            )
        } satisfies AppInboxEnqueueInput;

        const pending = service.enqueueAndWait(current);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const first = await pending;

        await expect(
            service.enqueueAndWait({
                ...current,
                data: encodeAppInboxCommand(
                    {
                        principalId: 'alice',
                        request: {
                            requestId: 'sparse-member-upsert',
                            actorPrincipalId: 'alice',
                            status: 'active'
                        },
                        groupId: 'group-1',
                        scope: { workspaceId: 'default', applicationId: 'ar-eye-hunter' }
                    } satisfies GroupMemberUpsertAppInboxPayload,
                    'Reordered group member upsert test command'
                )
            })
        ).resolves.toEqual(first);
        await expect(
            service.enqueueAndWait({
                ...current,
                data: encodeAppInboxCommand(
                    {
                        ...currentCommand,
                        request: { ...currentCommand.request, status: 'left' }
                    },
                    'Changed group member upsert test command'
                )
            })
        ).rejects.toMatchObject({ status: 409 });
        let getterCalls = 0;
        const unsafeCommand = {
            ...currentCommand,
            request: { ...currentCommand.request }
        };
        Object.defineProperty(unsafeCommand.request, 'role', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'member';
            }
        });
        expect(() => encodeAppInboxCommand(unsafeCommand, 'Unsafe accessor AppInbox command')).toThrow(/JSON-safe/u);
        expect(getterCalls).toBe(0);
        expect(() =>
            encodeAppInboxCommand(
                { ...currentCommand, unsafe: [undefined] },
                'Unsafe array AppInbox command'
            )
        ).toThrow(/JSON-safe/u);
        const cycle: Record<string, object> = {};
        cycle.self = cycle;
        for (
            const [label, value] of [
                ['unsafe-function', () => undefined],
                ['unsafe-bigint', 1n],
                ['unsafe-cycle', cycle],
                ['unsafe-nonfinite', Number.POSITIVE_INFINITY]
            ] as const
        ) {
            expect(() =>
                encodeAppInboxCommand(
                    { ...currentCommand, unsafe: value },
                    `Unsafe ${label} AppInbox command`
                )
            ).toThrow(/JSON-safe/u);
        }
        expect(handledPayloads).toEqual([current.data]);
    });

    it('preserves an own __proto__ key through write, replay, and conflict', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const handledPayloads: ProtoPayload[] = [];
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, async (data) => {
            const payload = decodeProtoPayload(data);
            handledPayloads.push(payload);
            return { accepted: payload };
        });
        const firstData: ProtoPayload = JSON.parse(
            '{"principalId":"alice","request":{"requestId":"proto-command",' +
                '"metadata":{"alpha":1,"__proto__":{"flag":"first"}}}}'
        );
        const input = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'proto-command',
            contextId: 'app:workspace:alice',
            senderId: 'alice',
            data: encodeAppInboxCommand(firstData, 'Prototype-key AppInbox command')
        } as const;

        const pending = service.enqueueAndWait(input);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const first = await pending;
        const reorderedData: ProtoPayload = JSON.parse(
            '{"request":{"metadata":{"__proto__":{"flag":"first"},"alpha":1},' +
                '"requestId":"proto-command"},"principalId":"alice"}'
        );

        await expect(
            service.enqueueAndWait({
                ...input,
                data: encodeAppInboxCommand(reorderedData, 'Reordered prototype-key AppInbox command')
            })
        ).resolves.toEqual(first);
        const changedData: ProtoPayload = JSON.parse(
            '{"principalId":"alice","request":{"requestId":"proto-command",' +
                '"metadata":{"alpha":1,"__proto__":{"flag":"changed"}}}}'
        );
        await expect(
            service.enqueueAndWait({
                ...input,
                data: encodeAppInboxCommand(changedData, 'Changed prototype-key AppInbox command')
            })
        ).rejects.toMatchObject({ status: 409 });

        const handled = handledPayloads[0];
        expect(handled).toBeDefined();
        if (handled === undefined) {
            throw new Error('Expected the AppInbox handler to receive the first payload');
        }
        const metadata = handled.request.metadata;
        expect(Object.hasOwn(metadata, '__proto__')).toBe(true);
        expect(metadata.__proto__).toEqual({ flag: 'first' });
        expect([Object.prototype, null]).toContain(Object.getPrototypeOf(metadata));
        expect(Object.hasOwn({}, 'flag')).toBe(false);
        const queuedEntry = await readOnlyEntry(queue);
        expect(queuedEntry).toBeDefined();
        if (queuedEntry === undefined) {
            throw new Error('Expected the first AppInbox command to remain available for replay');
        }
        const stored = readEnqueuedData<{
            request: { metadata: JsonWireObject; };
        }>(queuedEntry);
        expect(Object.hasOwn(stored.request.metadata, '__proto__')).toBe(true);
        expect(stored.request.metadata.__proto__).toEqual({ flag: 'first' });
    });

    it('rejects unsafe first-request JSON wire values before leaving any queue row', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        let handled = false;
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC
            }
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, async () => {
            handled = true;
            return { accepted: true };
        });
        let getterCalls = 0;
        const accessor: Record<string, string> = {};
        Object.defineProperty(accessor, 'value', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'unsafe';
            }
        });
        const cycle: Record<string, object> = {};
        cycle.self = cycle;
        const unsafeValues = [accessor, cycle, 1n, () => undefined, Number.NaN, [undefined]] as const;

        for (const [index, unsafe] of unsafeValues.entries()) {
            expect(() =>
                encodeAppInboxCommand(
                    { unsafe },
                    `Unsafe AppInbox command ${index}`
                )
            ).toThrow(/JSON-safe/u);
            expect(await readEntries(queue)).toHaveLength(0);
        }
        expect(getterCalls).toBe(0);
        expect(handled).toBe(false);
    });

    it('rejects changed semantics while replaying reordered equal content', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const handledPayloads: JsonWireObject[] = [];
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, async (data) => {
            const payload = data as JsonWireObject;
            handledPayloads.push(payload);
            return { accepted: payload };
        });
        const firstInput = {
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'same-public-request',
            contextId: 'app:workspace:alice',
            senderId: 'alice',
            data: {
                principalId: 'alice',
                request: {
                    requestId: 'same-public-request',
                    metadata: { alpha: 1, beta: 2 }
                }
            }
        } as const;
        const firstPromise = service.enqueueAndWait(firstInput);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        const first = await firstPromise;
        const reordered = await service.enqueueAndWait({
            senderId: 'alice',
            contextId: 'app:workspace:alice',
            resourceId: 'same-public-request',
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            data: {
                request: {
                    metadata: { beta: 2, alpha: 1 },
                    requestId: 'same-public-request'
                },
                principalId: 'alice'
            }
        });

        expect(reordered).toEqual(first);
        await expect(
            service.enqueueAndWait({
                ...firstInput,
                data: {
                    ...firstInput.data,
                    request: {
                        ...firstInput.data.request,
                        metadata: { alpha: 1, beta: 3 }
                    }
                }
            })
        ).rejects.toMatchObject({
            name: 'AppInboxIdempotencyConflictError',
            code: 'app-inbox-idempotency-conflict',
            status: 409
        });
        expect(handledPayloads).toEqual([firstInput.data]);
    });

    it('stores client idempotency conflict as terminal without queue retry', async () => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        const handler = () =>
            Promise.reject(
                new ClientMutationIdempotencyConflictError(
                    'same-request',
                    `sha256:${'a'.repeat(64)}`,
                    `sha256:${'b'.repeat(64)}`
                )
            );
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
        const pending = service.enqueueAndWait({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: 'same-request',
            contextId: 'app:workspace:alice',
            data: { requestId: 'same-request', username: 'alice' }
        });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const result = await pending;

        expect(result.left).toMatchObject({
            code: 'client-mutation-idempotency-conflict',
            status: 409
        });
        expect((await readOnlyEntry(queue))?.status).toBe(EntityStatus.FAILED);
        expect((await readOnlyEntry(queue))?.dequeueAudit.attempts).toBe(1);
    });

    it.each([
        [
            'client event',
            new ClientStateEventCollisionError({
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                principalId: 'alice',
                eventId: 'collision-event'
            }),
            'client-state-event-collision'
        ],
        [
            'group event',
            new GroupStateEventCollisionError({
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                groupId: 'collision-room',
                eventId: 'collision-event'
            }),
            'group-state-event-collision'
        ]
    ])('stores %s collision as terminal without queue retry', async (_label, error, code) => {
        const queue = new TestResourceInbox();
        const reader = new InboxQueueReader(queue);
        const results = new TestResourceInboxResults();
        const service = new TestAppInboxRuntime(
            {
                inboxQueueReader: reader,
                resourceInboxRepository: queue,
                resourceInboxResultsRepository: results,
                database: createAppInboxTestDatabase(queue, results)
            },
            {
                serviceId: 'server-12345678',
                defaultTopicId: CLIENT_STATE_APP_INBOX_TOPIC,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        const handler = () => Promise.reject(error);
        service.onStateMessage(AppInboxType.CLIENT_PRINCIPAL_UPSERT, handler);
        const pending = service.enqueueAndWait({
            type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
            resourceId: `terminal-${code}`,
            contextId: 'app:workspace:alice',
            data: { requestId: `terminal-${code}`, username: 'alice' }
        });

        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
        const result = await pending;

        expect(result.left).toMatchObject({ code, status: 409 });
        expect((await readOnlyEntry(queue))?.status).toBe(EntityStatus.FAILED);
        expect((await readOnlyEntry(queue))?.dequeueAudit.attempts).toBe(1);
    });
});

interface BeginMaterializedReservationInput {
    readonly placeholder: AppInboxEnqueueInput;
    readonly materialize: () => Promise<AppInboxEnqueueInput>;
}

interface MaterializedTestReservation {
    readonly winner: boolean;
    readonly result: Promise<Either<AppInboxFailure, JsonWireValue>>;
}

interface TestAppInboxDependencies {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxEntryRepository;
    readonly resourceInboxResultsRepository: AppInboxResultRepository;
    readonly database: PSqlSql;
}

interface TestAppInboxConfig {
    readonly serviceId: string;
    readonly defaultTopicId?: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxOptions;
    readonly wakeOwningQueue?: () => void;
}

class TestAppInboxRuntime {
    protected readonly clientRuntime: AppInboxClientRuntime;
    private readonly handlers: AppInboxHandlerRegistry;

    constructor(
        dependencies: TestAppInboxDependencies,
        config: TestAppInboxConfig
    ) {
        this.clientRuntime = createAppInboxClientRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resourceInboxRepository: dependencies.resourceInboxRepository,
            resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
            serviceId: config.serviceId,
            defaultTopicId: config.defaultTopicId ?? GROUP_STATE_APP_INBOX_TOPIC,
            timing: config.timing,
            options: config.options,
            wakeOwningQueue: config.wakeOwningQueue
        });
        this.handlers = createAppInboxHandlerRuntime({
            inboxQueueReader: dependencies.inboxQueueReader,
            resultRepository: dependencies.resourceInboxResultsRepository,
            database: dependencies.database,
            serviceId: config.serviceId,
            timing: config.timing,
            options: config.options
        }).registry;
    }

    onStateMessage<Result>(
        type: AppInboxType,
        handler: (
            data: JsonWireValue,
            context: AppInboxMessageContext<Result>
        ) => Promise<Result>
    ): void {
        this.handlers.registerHandler({
            type,
            decodeCommand: (value) => value,
            encodeResult: (result) => decodeJsonWireValue(result, 'Test AppInbox result'),
            handle: handler
        });
    }

    async enqueue(enqueue: AppInboxEnqueueInput): Promise<ResourceEntry> {
        return await this.clientRuntime.queueEntryWriter.enqueue(enqueue);
    }

    async enqueueAndWait(
        enqueue: AppInboxEnqueueInput
    ): Promise<Either<AppInboxFailure, JsonWireValue>> {
        return await this.clientRuntime.commandClient.enqueueAndWait(enqueue);
    }

    async enqueueAndWaitForResult<Result>(
        enqueue: AppInboxEnqueueInput,
        decodeResult: (value: JsonWireValue) => Result
    ): Promise<Either<AppInboxFailure, Result>> {
        return await this.clientRuntime.commandClient.enqueueAndWaitForResult(
            enqueue,
            decodeResult
        );
    }
}

class MaterializedTestAppInboxService extends TestAppInboxRuntime {
    async beginMaterializedReservation(
        input: BeginMaterializedReservationInput
    ): Promise<MaterializedTestReservation> {
        const reservation = await this.clientRuntime.reservationClient.reserveMaterializedEntry(
            input.placeholder,
            input.materialize
        );
        return {
            winner: reservation.winner,
            result: this.clientRuntime.resultWaiter.waitForReservedResult(
                reservation,
                (value) => value
            )
        };
    }
}

class TestResourceInbox extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }

    async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const key = toKeyAsString(placeholder.key);
        const active = this.materializations.get(key);
        if (active) {
            return await active;
        }
        const pending = this.materializeEntry(placeholder, materialize);
        this.materializations.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.materializations.delete(key);
        }
    }

    private async materializeEntry(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const existing = await this.getItem(placeholder.key);
        if (existing !== undefined && !isExpiredResourceEntry(existing)) {
            return existing;
        }
        const materialized = await materialize();
        return await this.enqueueIfAbsent({ ...placeholder, resource: materialized.resource });
    }
}

class CapturingInboxQueueReader extends InboxQueueReader {
    private callback: OnMessageCallback | undefined;

    override onInboxMessageDo(_type: string, callback: OnMessageCallback): this {
        this.callback = callback;
        return this;
    }

    async invoke(
        message: Parameters<OnMessageCallback['onMessage']>[0],
        entry: ResourceEntry
    ): Promise<void> {
        if (this.callback === undefined) {
            throw new Error('Expected AppInbox handler registration');
        }
        await this.callback.onMessage(message, entry);
    }
}

class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
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
        return entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry;
    }
}

async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));

    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
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

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    );
}

async function readOnlyEntry(queue: InMemoryQueueBox): Promise<ResourceEntry | undefined> {
    const [key] = await queue.getAllKeys();
    return key === undefined ? undefined : queue.getItem(key);
}

interface ProtoPayload {
    readonly principalId: string;
    readonly request: Readonly<{
        requestId: string;
        metadata: JsonWireObject;
    }>;
}

function decodeProtoPayload(value: JsonWireValue): ProtoPayload {
    if (!isJsonWireObject(value)) {
        throw new TypeError('Proto payload must be an object');
    }
    const request = value.request;
    if (
        typeof value.principalId !== 'string' ||
        !isJsonWireObject(request) ||
        typeof request.requestId !== 'string' ||
        !isJsonWireObject(request.metadata)
    ) {
        throw new TypeError('Proto payload fields are invalid');
    }
    return {
        principalId: value.principalId,
        request: {
            requestId: request.requestId,
            metadata: request.metadata
        }
    };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
