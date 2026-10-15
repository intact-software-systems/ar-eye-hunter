import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
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
            })
        ]);
    });
});

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
