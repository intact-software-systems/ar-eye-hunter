import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
import type { CreateRallarMiddlewareOptions } from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import type { QueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, type ResourceInboxRetryPolicy } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { createRallarMiddlewareTestRuntime, type RallarMiddlewareInboxConstructionEvent } from './rallar-middleware-test-runtime.ts';

describe('createRallarMiddleware', () => {
    it('constructs queuebox runtime services around supplied repositories', () => {
        const outbox = new InMemoryQueueBox();
        const appInboxResilience = createResilience();
        const appOutboxResilience = createResilience();
        const constructionEvents: RallarMiddlewareInboxConstructionEvent[] = [];
        const testRuntime = createRallarMiddlewareTestRuntime({
            outbox,
            wsRuntimeName: 'server-1',
            resilience: {
                inbox: createResilience(),
                outbox: createResilience(),
                appInbox: appInboxResilience,
                appOutbox: appOutboxResilience
            },
            constructionEvents
        });
        const runtime = createRallarMiddleware(testRuntime.options);
        const constructionTimeline = [...constructionEvents, 'worker-exposed'];

        expect(runtime.wsQBoxServerService).toBeInstanceOf(WsQueueBoxServerService);
        expect(runtime.wsQBoxServerService.inbox).toBe(testRuntime.inbox);
        expect(runtime.wsQBoxServerService.outbox).toBe(outbox);
        expect(runtime.wsQBoxServerService.name).toBe('server-1');
        expect(runtime.inboxQueueReader).toBeInstanceOf(InboxQueueReader);
        expect(runtime.inboxQueueReader.inbox).toBe(testRuntime.inbox);
        expect(runtime.outboxQueueReader).toBeInstanceOf(OutboxQueueReader);
        expect(runtime.outboxQueueReader.outbox).toBe(outbox);
        expect(runtime.appInboxResilience).toBe(appInboxResilience);
        expect(runtime.appOutboxResilience).toBe(appOutboxResilience);
        expect(runtime.groupStateInboxService).toBeInstanceOf(GroupStateInboxService);
        expect(runtime.topologyInboxService).toBeInstanceOf(TopologyInboxService);
        expect(runtime.rtcRttInboxService).toBeInstanceOf(RtcRttInboxService);
        expect(runtime.appClientInboxService).toBeInstanceOf(AppClientInboxService);
        expect(constructionTimeline).toEqual([
            'group-state-handlers-registered',
            'topology-handlers-registered',
            'rtc-rtt-handlers-registered',
            'client-state-handlers-registered',
            'worker-exposed'
        ]);
    });

    it('waits for runtime and queue pubsub subscription readiness', async () => {
        const runtimeStartup = Promise.withResolvers<void>();
        const queueSubscription = Promise.withResolvers<void>();
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: vi.fn(async () => await queueSubscription.promise)
        };
        const runtime = createRallarMiddleware(
            createReadinessMiddlewareOptions(runtimeStartup.promise, bridge)
        );
        let ready = false;
        void runtime.readiness.then(() => {
            ready = true;
        });

        runtimeStartup.resolve();
        await Promise.resolve();

        expect(bridge.subscribe).toHaveBeenCalledWith(
            'queuebox-events',
            expect.any(Function)
        );
        expect(ready).toBe(false);

        queueSubscription.resolve();
        await runtime.readiness;

        expect(ready).toBe(true);
    });

    it('fails runtime readiness when queue pubsub subscription fails', async () => {
        const failure = new Error('queue subscription failed');
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: async () => {
                throw failure;
            }
        };
        const reportFailure = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const runtime = createRallarMiddleware(
            createReadinessMiddlewareOptions(Promise.resolve(), bridge)
        );

        await expect(runtime.readiness).rejects.toBe(failure);
        reportFailure.mockRestore();
    });

    it('exposes the process health failure channel without changing readiness', async () => {
        const healthFailure = new Promise<never>(() => undefined);
        const runtime = createRallarMiddleware({
            ...createReadinessMiddlewareOptions(
                Promise.resolve(),
                {
                    publish: async () => undefined,
                    subscribe: async () => undefined
                }
            ),
            healthFailure
        });

        await expect(runtime.readiness).resolves.toBeUndefined();
        expect(runtime.healthFailure).toBe(healthFailure);
    });

    it('rejects a configured inbox factory that does not construct its service', () => {
        const options = createReadinessMiddlewareOptions(
            Promise.resolve(),
            {
                publish: async () => undefined,
                subscribe: async () => undefined
            }
        );
        Object.defineProperty(options, 'createAppAuthInboxService', {
            enumerable: true,
            value: () => undefined
        });

        expect(() => createRallarMiddleware(options)).toThrow(
            'Rallar middleware inbox service construction is incomplete'
        );
    });

    it('registers an app inbox engine task that drains inbox messages', async () => {
        const testRuntime = createRallarMiddlewareTestRuntime({
            resilience: {
                inbox: createResilience(),
                appOutbox: createResilience()
            }
        });
        const runtime = createRallarMiddleware(testRuntime.options);
        const receivedMessages: ALMessage[] = [];
        const message = newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.group-state', 'group-1', 'request-1'),
            'group-state.create.v1',
            { requestId: 'request-1' }
        );

        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (receivedMessage) => {
                receivedMessages.push(receivedMessage);
            }
        });
        await runtime.inboxQueueReader.enqueueIfAbsent(message);
        await runtime.qboxEngine.executeOnce();

        await vi.waitFor(() => expect(receivedMessages).toEqual([message]));
    });

    it('uses one custom retry budget for app inbox advertisement and reservation', async () => {
        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2
        };
        const resilience = createResilience(retryPolicy);
        const testRuntime = createRallarMiddlewareTestRuntime({
            resilience: {
                inbox: resilience,
                appInbox: resilience,
                appOutbox: createResilience()
            }
        });
        const runtime = createRallarMiddleware(testRuntime.options);
        const inbox = testRuntime.inbox;
        const receivedMessages: ALMessage[] = [];
        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (receivedMessage) => {
                receivedMessages.push(receivedMessage);
            }
        });
        const enqueued = await runtime.inboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-inbox.group-state', 'group-1', 'request-exhausted'),
                'group-state.create.v1',
                { requestId: 'request-exhausted' }
            )
        );
        await inbox.enqueue({
            ...enqueued,
            dequeueAudit: { ...enqueued.dequeueAudit, attempts: 2 }
        });
        await runtime.qboxEngine.executeOnce();

        expect(receivedMessages).toEqual([]);
        expect(await inbox.getItem(enqueued.key)).toMatchObject({
            status: enqueued.status,
            dequeueAudit: { attempts: 2 }
        });
    });

    it('registers an independent app outbox engine task', async () => {
        const outbox = new InMemoryQueueBox();
        const testRuntime = createRallarMiddlewareTestRuntime({
            outbox,
            resilience: {
                inbox: createResilience(),
                appInbox: createResilience(),
                appOutbox: createResilience()
            }
        });
        const runtime = createRallarMiddleware(testRuntime.options);
        const receivedMessages: ALMessage[] = [];
        const message = newALUntargetedMessage(
            'api-v1',
            newALRoute('app-outbox.worker-test', 'message-1', 'worker-1'),
            'worker-test.message.v1',
            { message: 'outbox work' }
        );

        runtime.outboxQueueReader.onOutboxMessageDo(
            'worker-test.message.v1',
            {
                onMessage: async (receivedMessage) => {
                    receivedMessages.push(receivedMessage);
                }
            }
        );
        await runtime.outboxQueueReader.enqueueIfAbsent(message);
        await runtime.qboxEngine.executeOnce();

        await vi.waitFor(() => expect(receivedMessages).toEqual([message]));
    });

    it('continues draining APP_INBOX while an APP_OUTBOX handler is blocked', async () => {
        const testRuntime = createRallarMiddlewareTestRuntime({
            resilience: {
                inbox: createResilience(),
                appInbox: createResilience(),
                appOutbox: createResilience()
            }
        });
        const runtime = createRallarMiddleware(testRuntime.options);
        const queue = testRuntime.outbox;
        const outboxBlocked = Promise.withResolvers<void>();
        const receivedInboxMessages: ALMessage[] = [];
        const receivedOutboxMessages: ALMessage[] = [];
        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (receivedMessage) => {
                receivedInboxMessages.push(receivedMessage);
            }
        });
        runtime.outboxQueueReader.onOutboxMessageDo(
            'worker-test.message.v1',
            {
                onMessage: async (receivedMessage) => {
                    receivedOutboxMessages.push(receivedMessage);
                    await outboxBlocked.promise;
                }
            }
        );
        const outboxEntry = await runtime.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-outbox.worker-test', 'message-1', 'worker-1'),
                'worker-test.message.v1',
                { message: 'outbox work' }
            )
        );
        try {
            await runtime.qboxEngine.executeOnce();
            await vi.waitFor(() => expect(receivedOutboxMessages).toHaveLength(1));
            await runtime.inboxQueueReader.enqueueIfAbsent(
                newALUntargetedMessage(
                    'api-v1',
                    newALRoute('app-inbox.group-state', 'group-1', 'request-1'),
                    'group-state.create.v1',
                    { requestId: 'request-1' }
                )
            );
            await runtime.qboxEngine.executeOnce();

            await vi.waitFor(() => expect(receivedInboxMessages).toHaveLength(1));
        }
        finally {
            outboxBlocked.resolve();
        }
        await vi.waitFor(async () => {
            expect((await queue.getItem(outboxEntry.key))?.status).toBe(EntityStatus.COMPLETED);
        });
    });
});

function createResilience(
    retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY
): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
        ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy
    );
}

function createReadinessMiddlewareOptions(
    readiness: Promise<void>,
    bridge: QueueBoxPubSubBridge
): CreateRallarMiddlewareOptions {
    return createRallarMiddlewareTestRuntime({
        resilience: {
            inbox: createResilience(),
            appOutbox: createResilience()
        },
        readiness,
        queuePubSubBridge: {
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        }
    }).options;
}
