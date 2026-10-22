import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    createDeltaEnvelopeFixture,
    DELTA_ENVELOPE_FIXTURE_GROUP_REF
} from '../group-state/presence/group-state-delta-envelope-fixtures.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

const AUDIENCE = ['alice-session', 'bob-session'];

describe('Rallar middleware group-state delta delivery', () => {
    // Step 2g D300 completed an older queued delta of a group unsent once a newer one was queued: its GroupEvent
    // never reached `rallar.rooms.onEvent`, and every recipient behind it re-read the whole snapshot.
    it('publishes every queued delta of one group in queue order, so each event reaches its listeners', async () => {
        const resilience = createResilience();
        const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, outbox: resilience, appOutbox: resilience } });
        const queueEngine = new InboxOutboxEngine();
        const infrastructure = createRallarMiddlewareInfrastructure(
            {
                ...fixture.options,
                webSocketServer: new JsonWebSocketServer(),
                readWsOutboxProducerProvenance: async () => ({ admittedAudience: AUDIENCE, recipientScope: undefined })
            },
            queueEngine
        );
        onTestFinished(() => infrastructure.wsQBoxServerService.dispose());
        const published: string[] = [];
        infrastructure.wsQBoxServerService.onOutboxClusterPublishDo(async (message) => {
            published.push(message.route.resourceId);
        });
        await queueEngine.executeOnce();
        for (const index of [0, 1, 2]) {
            await fixture.outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(
                toDeltaMessage(index),
                EnqueuedType.WS_OUTBOX,
                Temporal.Now.instant()
            ));
        }

        infrastructure.wakeQueueEngine();
        await queueEngine.executeOnce();

        // The outbound owner's batch runs after the engine pass that woke it: observe its settled publications.
        await expect.poll(() => published, { timeout: 2_000 }).toHaveLength(3);
        expect(published).toEqual(['event-0', 'event-1', 'event-2']);
    });
});

function toDeltaMessage(index: number): ALMessage {
    const fixture = createDeltaEnvelopeFixture({ audienceSessionIds: AUDIENCE });
    const resulting = { groupRevision: 3 + index, presenceRevision: 2 };
    const envelope: GroupStateDeltaEnvelope = {
        ...fixture,
        event: { ...fixture.event, eventId: `event-${index}`, causalRevision: resulting, snapshotVersion: resulting.groupRevision },
        predecessorCausalRevision: { groupRevision: 2 + index, presenceRevision: 2 },
        resultingCausalRevision: resulting,
        group: { ...fixture.group, snapshotVersion: resulting.groupRevision, presenceVersion: resulting.presenceRevision }
    };
    return newALBroadcastMessage(
        'rallar-server',
        newALEventRoute(AppTopics.groupStateEvent, DELTA_ENVELOPE_FIXTURE_GROUP_REF.groupId, `event-${index}`),
        'room',
        AppTopics.groupStateEvent,
        envelope,
        {
            groupRef: DELTA_ENVELOPE_FIXTURE_GROUP_REF,
            recipientPeerIds: AUDIENCE,
            ttlMs: 60_000,
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration)
    });
}
