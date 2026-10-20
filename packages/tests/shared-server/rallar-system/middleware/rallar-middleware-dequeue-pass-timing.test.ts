import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { QueueMessageReader } from '@shared/services/queue-message-reader.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

describe('Rallar middleware dequeue-pass timing', () => {
    it('installs the dequeue-pass timing once on the inbox reader, attributed to the server', async () => {
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const timing: RallarTimingEvent[] = [];
        const infrastructure = createRallarMiddlewareInfrastructure(
            {
                ...fixture.options,
                webSocketServer: new JsonWebSocketServer(),
                appInboxDequeuePassTiming: {
                    database: { getExecutorCounters: () => ({ statements: 0, executorWaitMs: 0 }) },
                    serviceId: 'server-1',
                    sink: (event) => timing.push(event)
                }
            },
            new InboxOutboxEngine()
        );
        onTestFinished(() => infrastructure.wsQBoxServerService.dispose());
        const reader = infrastructure.inboxQueueReader;
        reader.onInboxMessageDo('test.dequeue-pass', { onMessage: async () => undefined });
        await reader.enqueueIfAbsent(newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.test', 'test-scope', 'claimed'),
            'test.dequeue-pass',
            {},
            { ttlMs: 300_000 }
        ));

        const advertisedLanes = await reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);

        expect(timing).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass',
                serviceId: 'server-1',
                requestId: 'claimed',
                details: expect.objectContaining({ lanesProbed: 'NEW', claimedInPass: 1, statements: 0 })
            }),
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass-boundary',
                serviceId: 'server-1',
                details: expect.objectContaining({ queueType: 'APP_INBOX', lanesProbed: 'NEW', claimedInPass: 1, claimedNew: 1 })
            })
        ]);
    });

    it('closes a pass that claimed nothing with its boundary line', async () => {
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const timing: RallarTimingEvent[] = [];
        const infrastructure = createRallarMiddlewareInfrastructure(
            {
                ...fixture.options,
                webSocketServer: new JsonWebSocketServer(),
                appInboxDequeuePassTiming: {
                    database: { getExecutorCounters: () => ({ statements: 0, executorWaitMs: 0 }) },
                    serviceId: 'server-1',
                    sink: (event) => timing.push(event)
                }
            },
            new InboxOutboxEngine()
        );
        onTestFinished(() => infrastructure.wsQBoxServerService.dispose());

        expect(await infrastructure.inboxQueueReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience)).toBe(0);

        expect(timing).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass-boundary',
                serviceId: 'server-1',
                details: expect.objectContaining({ queueType: 'APP_INBOX', lanesProbed: '', claimedInPass: 0, claimedNew: 0 })
            })
        ]);
    });

    it('reads no timing clock and installs no observer when phase timing is off', async () => {
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const infrastructure = createRallarMiddlewareInfrastructure(
            { ...fixture.options, webSocketServer: new JsonWebSocketServer() },
            new InboxOutboxEngine()
        );
        onTestFinished(() => infrastructure.wsQBoxServerService.dispose());
        const reader = infrastructure.inboxQueueReader;
        reader.onInboxMessageDo('test.dequeue-pass', { onMessage: async () => undefined });
        await reader.enqueueIfAbsent(newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.test', 'test-scope', 'claimed'),
            'test.dequeue-pass',
            {},
            { ttlMs: 300_000 }
        ));
        const timingClockReads: number[] = [];
        const readTimingClock = performance.now.bind(performance);
        const timingClock = vi.spyOn(performance, 'now').mockImplementation(() => {
            const atMs = readTimingClock();
            timingClockReads.push(atMs);
            return atMs;
        });
        onTestFinished(() => timingClock.mockRestore());

        const advertisedLanes = await reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        expect(await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);
        expect(await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience)).toBe(0);

        expect(timingClockReads).toEqual([]);
        // The reader holds one observer at most, so installing one now proves none was installed.
        expect(() => reader.onDequeuePassDo(createInertDequeuePassObserver())).not.toThrow();
    });

    it('reports the outbox pass with the claimed outbox type, attributed to the server', async () => {
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const timing: RallarTimingEvent[] = [];
        const infrastructure = createRallarMiddlewareInfrastructure(
            {
                ...fixture.options,
                webSocketServer: new JsonWebSocketServer(),
                appInboxDequeuePassTiming: {
                    database: { getExecutorCounters: () => ({ statements: 0, executorWaitMs: 0 }) },
                    serviceId: 'server-1',
                    sink: (event) => timing.push(event)
                }
            },
            new InboxOutboxEngine()
        );
        onTestFinished(() => infrastructure.wsQBoxServerService.dispose());
        const reader = infrastructure.outboxQueueReader;
        reader.onOutboxMessageDo('test.outbox-pass', { onMessage: async () => undefined });
        await reader.enqueueIfAbsent(newALUntargetedMessage(
            'api-v1',
            newALRoute('app-outbox.test', 'test-scope', 'claimed-outbox'),
            'test.outbox-pass',
            {},
            { ttlMs: 300_000 }
        ));

        const advertisedLanes = await reader.readWorkAdvertisement(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, resilience);
        expect(await reader.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, resilience, advertisedLanes)).toBe(1);

        expect(timing).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass',
                serviceId: 'server-1',
                requestId: 'claimed-outbox',
                details: expect.objectContaining({
                    type: 'test.outbox-pass',
                    topicId: 'app-outbox.test',
                    selectedLane: 'NEW',
                    lanesProbed: 'NEW',
                    claimedInPass: 1,
                    statements: 0
                })
            }),
            expect.objectContaining({
                operation: 'dequeue-pass-boundary',
                serviceId: 'server-1',
                details: expect.objectContaining({ queueType: 'APP_OUTBOX', lanesProbed: 'NEW', claimedInPass: 1, claimedNew: 1 })
            })
        ]);
    });
});

function createInertDequeuePassObserver(): QueueMessageReader.DequeuePassObserver {
    return {
        onProbeStarted: () => undefined,
        onProbeFinished: () => undefined,
        onPassStarted: () => undefined,
        onPassFinished: () => undefined,
        onHandlerStarted: () => undefined,
        onHandlerFinished: () => undefined
    };
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}
