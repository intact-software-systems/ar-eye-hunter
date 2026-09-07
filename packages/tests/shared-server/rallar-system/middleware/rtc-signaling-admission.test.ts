import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

const invalidIngressCases = [
    'payload',
    'origin',
    'topic',
    'payload-type',
    'page',
    AppTopics.overlayTopology,
    AppTopics.groupStateSnapshot,
    AppTopics.groupDirectorySnapshot,
    AppTopics.clientStateSnapshot
] as const;
type InvalidIngressCase = typeof invalidIngressCases[number];

describe('middleware pre-admission', () => {
    it.each(invalidIngressCases)(
        'rejects invalid %s before any AL state or relay',
        async (corruption) => {
            const admission = createInMemoryALAdmissionState();
            const socket = new JsonWebSocketServer();
            const sender = new SimulatedWebSocket('ws://sender');
            const receiver = new SimulatedWebSocket('ws://receiver');
            await sender.open();
            await receiver.open();
            socket.addConnection(new ConnectionContext({ id: 'sender', socket: sender }));
            socket.addConnection(new ConnectionContext({ id: 'receiver', socket: receiver }));
            const duration = Temporal.Duration.from({ seconds: 10 });
            const resilience = ResilienceDto.toResilienceDto(new CircuitBreakerPolicy(10, duration, duration, duration), 1, 10, 1, 1);
            const fixture = createRallarMiddlewareTestRuntime({ resilience: { inbox: resilience, appOutbox: resilience } });
            const runtime = createRallarMiddleware({
                ...fixture.options,
                webSocketServer: socket,
                inboundStores: {
                    admissionStore: createALInboundAdmissionStore({
                        namespace: 'middleware-signaling',
                        backend: new InMemoryAdmissionBackend(admission, Date.now),
                        orderingTrackTtlMs: 60_000,
                        supersedenceTrackTtlMs: 60_000,
                        retention: normalizeALRuntimeStoreRetention()
                    })
                }
            });
            onTestFinished(() => runtime.wsQBoxServerService.dispose());
            const valid = signalingMessage();
            const invalid = invalidMessage(valid, corruption);

            await sender.receive(JSON.stringify(invalid));

            expect(admission.data.size).toBe(0);
            expect(await fixture.inbox.getAllKeys()).toEqual([]);
            expect(await fixture.outbox.getAllKeys()).toEqual([]);
            expect(sender.sent).toEqual([]);
            expect(receiver.sent).toEqual([]);

            await sender.receive(JSON.stringify(valid));

            expect(receiver.sent).toEqual([JSON.stringify(valid)]);
            expect(admission.data.size).toBeGreaterThan(0);
        }
    );
});

function signalingMessage(): ALMessage {
    return newALUnicastMessage('sender', newALEventRoute(AppTopics.rtcSignaling, 'receiver', 'offer'), 'receiver', AppTopics.rtcSignaling, {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: 'sender',
        toId: 'receiver',
        sessionId: 'sender',
        token: 'fixture-ticket',
        signalType: 'Offer',
        payload: { description: { type: 'offer', sdp: 'sdp' }, candidate: null }
    });
}

function invalidMessage(message: ALMessage, corruption: InvalidIngressCase): ALMessage {
    if (isStateSnapshotTopic(corruption) || corruption === 'page') {
        return {
            ...message,
            route: { ...message.route, topicId: 'app.other' },
            payload: {
                ...message.payload,
                typeId: corruption === 'page' ? 'app.other' : corruption,
                resource: JSON.stringify(corruption === 'page' ? { kind: 'state-snapshot-page' } : { version: 1 })
            }
        };
    }
    switch (corruption) {
        case 'topic':
            return { ...message, route: { ...message.route, topicId: 'app.other' } };
        case 'payload-type':
            return { ...message, payload: { ...message.payload, typeId: 'app.other' } };
        case 'payload':
            return { ...message, payload: { ...message.payload, resource: '{"malformed":true}' } };
        case 'origin':
            return {
                ...message,
                payload: { ...message.payload, resource: message.payload.resource.replace('"fromId":"sender"', '"fromId":"victim"') }
            };
        default:
            throw new Error('Unrecognized invalid ingress fixture');
    }
}
