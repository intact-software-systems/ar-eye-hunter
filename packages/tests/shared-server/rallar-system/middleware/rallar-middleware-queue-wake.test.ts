import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

describe('Rallar middleware queue wake', () => {
    it('progresses an external WS_OUTBOX write after an occupied batch settles without idle backoff', async () => {
        vi.useFakeTimers();
        const releaseAuthority = Promise.withResolvers<void>();
        const firstMessage = createOutboundMessage();
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const queueEngine = new InboxOutboxEngine();
        const infrastructure = createRallarMiddlewareInfrastructure(
            {
                ...fixture.options,
                webSocketServer: new JsonWebSocketServer(),
                readWsOutboxProducerProvenance: async (message) => {
                    if (message.id.msgId === firstMessage.id.msgId) {
                        await releaseAuthority.promise;
                    }
                    return { admittedAudience: [], recipientScope: { applicationId: 'app', workspaceId: 'workspace' } };
                }
            },
            queueEngine
        );
        onTestFinished(async () => {
            releaseAuthority.resolve();
            await infrastructure.wsQBoxServerService.dispose();
            await queueEngine.stop();
            vi.useRealTimers();
        });
        queueEngine.start();
        await vi.advanceTimersByTimeAsync(10_000);

        const first = QueueBoxUtilities.toResourceEntryFromMsg(firstMessage, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await fixture.outbox.enqueueIfAbsent(first);
        infrastructure.wakeQueueEngine();
        await vi.advanceTimersByTimeAsync(1);
        expect(await readOutboxEntry(fixture.outbox, first)).toMatchObject({ status: EntityStatus.RESERVED });

        const next = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage(), EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await fixture.outbox.enqueueIfAbsent(next);
        infrastructure.wakeQueueEngine();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await readOutboxEntry(fixture.outbox, next)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });

        releaseAuthority.resolve();
        await vi.advanceTimersByTimeAsync(10);
        expect(await readOutboxEntry(fixture.outbox, next)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 1 }
        });
    });

    it.each([true, false])('drives the registered outbound owner (producer proof available: %s)', async (proofAvailable) => {
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const queueEngine = new InboxOutboxEngine();
        const infrastructure = createRallarMiddlewareInfrastructure(
            {
                ...fixture.options,
                webSocketServer: new JsonWebSocketServer(),
                readWsOutboxProducerProvenance: proofAvailable
                    ? async () => ({
                        admittedAudience: [],
                        recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
                    })
                    : undefined
            },
            queueEngine
        );
        onTestFinished(() => infrastructure.wsQBoxServerService.dispose());
        // One pass with an empty queue leaves the outbound owner remembering "no work".
        await queueEngine.executeOnce();

        // A server mutation writes its WS_OUTBOX row inside its own transaction, so the owner learns
        // of it only from the wake that follows the commit.
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage(), EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        await fixture.outbox.enqueueIfAbsent(entry);
        await queueEngine.executeOnce();

        // Nothing read storage: the owner's remembered "no work" answered the whole pass.
        expect(await readOutboxEntry(fixture.outbox, entry)).toMatchObject({
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: 0 }
        });

        infrastructure.wakeQueueEngine();
        await queueEngine.executeOnce();

        // The wake reaches the same owner with or without producer proof. Observe its settled
        // outcome, not the asynchronous claim's transient RESERVED state. Empty audience is final.
        await expect.poll(async () => await readOutboxEntry(fixture.outbox, entry)).toMatchObject({
            status: proofAvailable ? EntityStatus.COMPLETED : EntityStatus.NON_RETRYABLE,
            dequeueAudit: { attempts: 1 }
        });
    });
});

async function readOutboxEntry(
    outbox: QueueBoxResourceEntryRepository,
    entry: ResourceEntry
): Promise<ResourceEntry> {
    const current = await outbox.getItem(entry.key);
    if (!current) {
        throw new Error('The WS_OUTBOX row written straight into the queue is gone');
    }
    return current;
}

function createOutboundMessage(): ALMessage {
    return newALUnicastMessage(
        'rallar-server',
        newALEventRoute('chat.message.v1', 'remote-peer'),
        'remote-peer',
        'chat.message.v1',
        { text: 'written straight into the queue' },
        { ttlMs: 60_000, qos: { durability: { algo: 'local-outbox' } } }
    );
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration)
    });
}
