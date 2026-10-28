import { describe, expect, it } from 'vitest';

import { installRtcSignalingWsTopic } from '@shared-server/rallar-system/communication/install-rtc-signaling-ws-topic.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import type { LiveWsNotice, LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import {
    createServerIngressFixture,
    type ServerIngressFixture
} from '../../../shared/services/ws-queue-box-server-ingress-fixture.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };
const CHANNEL = 'ws-channel';

describe('the RTC signaling relay', () => {
    it('sends a signal to a recipient connected here without awaiting or publishing a notice', async () => {
        const fixture = await createServerIngressFixture(undefined, 'sender');
        const receiver = await connectReceiver(fixture);
        const notices: LiveWsNotice[] = [];
        let release: () => void = () => undefined;
        const unreleased = new Promise<void>((resolve) => {
            release = resolve;
        });
        // A notice that never settles until released: a local send queued behind it would never happen.
        installRtcSignalingWsTopic({
            service: fixture.service,
            publication: {
                transport: {
                    publish: async (notice) => {
                        notices.push(notice);
                        await unreleased;
                    },
                    subscribe: async () => {}
                },
                channel: CHANNEL,
                publisherId: 'publisher-a'
            },
            readConnectionCurrentness: async () => true,
            nowEpochMs: Date.now,
            timing: undefined
        });
        const message = signalingMessage('offer-1');

        expect((await fixture.service.acceptIncomingMessage(message, 'sender')).right?.kind).toBe('admitted');

        await expect.poll(() => receiver.sent, { timeout: 2_000 }).toEqual([JSON.stringify(message)]);
        expect(notices).toEqual([]);
        release();
    });

    it('publishes a signal no socket here takes, and its recipient on another server receives it once', async () => {
        const bus = createLiveWsNoticeBus();
        const serverA = await createServerIngressFixture(undefined, 'sender');
        const serverB = await createServerIngressFixture(undefined, 'peer-b');
        const receiver = await connectReceiver(serverB);
        await installSubscriber(serverA, bus, 'publisher-a');
        await installSubscriber(serverB, bus, 'publisher-b');
        installRtcSignalingWsTopic({
            service: serverA.service,
            publication: { transport: bus, channel: CHANNEL, publisherId: 'publisher-a' },
            readConnectionCurrentness: async () => true,
            nowEpochMs: Date.now,
            timing: undefined
        });
        const message = signalingMessage('offer-1');

        expect((await serverA.service.acceptIncomingMessage(message, 'sender')).right?.kind).toBe('admitted');

        await expect.poll(() => bus.published.length).toBe(1);
        expect(bus.published[0]).toMatchObject({
            delivery: 'inline',
            scope,
            audience: { mode: 'peer', recipientSessionIds: ['receiver'] },
            message: { id: message.id, targets: message.targets, payload: message.payload }
        });
        expect(receiver.sent).toEqual([JSON.stringify(message)]);
    });

    it('publishes a signal a stale socket here took, and the live socket on another server receives it', async () => {
        const bus = createLiveWsNoticeBus();
        const serverA = await createServerIngressFixture(undefined, 'sender');
        const serverB = await createServerIngressFixture(undefined, 'peer-b');
        // The recipient reconnected to server B; its old socket here is not yet reaped.
        const staleReceiver = await connectReceiver(serverA);
        const liveReceiver = await connectReceiver(serverB);
        await installSubscriber(serverA, bus, 'publisher-a');
        await installSubscriber(serverB, bus, 'publisher-b');
        installRtcSignalingWsTopic({
            service: serverA.service,
            publication: { transport: bus, channel: CHANNEL, publisherId: 'publisher-a' },
            readConnectionCurrentness: async () => false,
            nowEpochMs: Date.now,
            timing: undefined
        });
        const message = signalingMessage('offer-1');

        expect((await serverA.service.acceptIncomingMessage(message, 'sender')).right?.kind).toBe('admitted');

        await expect.poll(() => liveReceiver.sent, { timeout: 2_000 }).toEqual([JSON.stringify(message)]);
        expect(staleReceiver.sent).toEqual([JSON.stringify(message)]);
        expect(bus.published).toHaveLength(1);
    });

    it('publishes a signal whose local recipient is not current for its scope', async () => {
        const fixture = await createServerIngressFixture(
            undefined,
            'sender',
            (connection) => ({
                scope: connection.id === 'receiver' ? { applicationId: 'other', workspaceId: 'workspace' } : scope,
                expiresAtEpochMs: Date.now() + 60_000
            })
        );
        const receiver = await connectReceiver(fixture);
        const bus = createLiveWsNoticeBus();
        installRtcSignalingWsTopic({
            service: fixture.service,
            publication: { transport: bus, channel: CHANNEL, publisherId: 'publisher-a' },
            readConnectionCurrentness: async () => true,
            nowEpochMs: Date.now,
            timing: undefined
        });

        expect((await fixture.service.acceptIncomingMessage(signalingMessage('offer-1'), 'sender')).right?.kind)
            .toBe('admitted');

        await expect.poll(() => bus.published.length).toBe(1);
        expect(receiver.sent).toEqual([]);
    });

    it('names the shared admission of a signal too large to travel inline', async () => {
        const fixture = await createServerIngressFixture(undefined, 'sender');
        const bus = createLiveWsNoticeBus();
        installRtcSignalingWsTopic({
            service: fixture.service,
            publication: { transport: bus, channel: CHANNEL, publisherId: 'publisher-a' },
            readConnectionCurrentness: async () => true,
            nowEpochMs: Date.now,
            timing: undefined
        });
        const message = signalingMessage('offer-1', { sdp: 'v=0\r\n'.repeat(2_000) });

        expect((await fixture.service.acceptIncomingMessage(message, 'sender')).right?.kind).toBe('admitted');

        await expect.poll(() => bus.published.length).toBe(1);
        expect(bus.published[0]).toMatchObject({
            delivery: 'inbound-key',
            inbound: {
                namespace: fixture.service.getInboundNamespace(),
                reference: { senderId: 'sender', msgId: message.id.msgId }
            }
        });
    });

    it('records each relayed signal as a timing row named for where it went', async () => {
        const fixture = await createServerIngressFixture(undefined, 'sender');
        await connectReceiver(fixture);
        const timing: RallarTimingEvent[] = [];
        installRtcSignalingWsTopic({
            service: fixture.service,
            publication: { transport: createLiveWsNoticeBus(), channel: CHANNEL, publisherId: 'publisher-a' },
            readConnectionCurrentness: async () => true,
            nowEpochMs: Date.now,
            timing: (event) => timing.push(event)
        });
        const local = signalingMessage('offer-1');
        const remote = signalingMessage('offer-2', { toId: 'remote' });

        await fixture.service.acceptIncomingMessage(local, 'sender');
        await fixture.service.acceptIncomingMessage(remote, 'sender');

        await expect.poll(() => timing.length).toBe(2);
        expect(timing).toEqual(expect.arrayContaining([
            expect.objectContaining({
                component: 'rtc-signaling-relay',
                operation: 'local-send',
                status: 'ok',
                sessionId: 'receiver',
                traceId: 'trace-offer-1',
                details: { msgId: local.id.msgId, senderId: 'sender', recipientCount: 1, sentCount: 1 }
            }),
            expect.objectContaining({
                component: 'rtc-signaling-relay',
                operation: 'cluster-notice',
                status: 'ok',
                sessionId: 'remote',
                traceId: 'trace-offer-2',
                details: { msgId: remote.id.msgId, senderId: 'sender', recipientCount: 0, sentCount: 0 }
            })
        ]));
    });

    it('keeps non-RTC unicast on the ordinary forwarding path', async () => {
        const fixture = await createServerIngressFixture(undefined, 'sender');
        const receiver = await connectReceiver(fixture);
        const bus = createLiveWsNoticeBus();
        installRtcSignalingWsTopic({
            service: fixture.service,
            publication: { transport: bus, channel: CHANNEL, publisherId: 'publisher-a' },
            readConnectionCurrentness: async () => true,
            nowEpochMs: Date.now,
            timing: undefined
        });
        const message = newALUnicastMessage(
            'sender',
            newALEventRoute('topic', 'receiver', 'ordinary'),
            'receiver',
            'message.v1',
            { value: 'ordinary' }
        );

        expect((await fixture.service.acceptIncomingMessage(message, 'sender')).right?.kind).toBe('admitted');
        await expect.poll(() => receiver.sent.length).toBe(1);
        expect(receiver.sent).toEqual([JSON.stringify(message)]);
        expect(bus.published).toEqual([]);
        expect(fixture.delivered).toEqual([]);
    });
});

interface LiveWsNoticeBus extends LiveWsNoticeTransport {
    readonly published: LiveWsNotice[];
}

/** Every subscriber receives every notice, its own publisher's included, as PostgreSQL LISTEN does. */
function createLiveWsNoticeBus(): LiveWsNoticeBus {
    const subscribers: ((notice: LiveWsNotice) => Promise<void> | void)[] = [];
    const published: LiveWsNotice[] = [];
    return {
        published,
        publish: async (notice) => {
            published.push(notice);
            for (const subscriber of subscribers) {
                await subscriber(notice);
            }
        },
        subscribe: async (_channel, onNotice) => {
            subscribers.push(onNotice);
        }
    };
}

async function installSubscriber(
    fixture: ServerIngressFixture,
    bus: LiveWsNoticeBus,
    publisherId: string
): Promise<void> {
    await installLiveWsNoticeSubscriber({
        transport: bus,
        channel: CHANNEL,
        publisherId,
        nowMs: Date.now,
        inboundStores: [fixture.admissionStore],
        resolveBroadRecipientSessionIds: () => [],
        filterEligibleRecipientSessionIds: (ids) => ids,
        sendToTargetsWithResult: ({ message, recipientSessionIds, notice }) => {
            fixture.service.sendToTargetsWithResult({
                message,
                expiresAtMs: notice.expiresAtMs,
                recipientSessionIds,
                inboundScope: notice.scope,
                recipientScope: notice.scope,
                requireAuthenticatedRecipient: true
            });
        }
    });
}

async function connectReceiver(fixture: ServerIngressFixture): Promise<SimulatedWebSocket> {
    const receiver = new SimulatedWebSocket('ws://receiver');
    await receiver.open();
    fixture.server.addConnection(new ConnectionContext({ id: 'receiver', socket: receiver }));
    return receiver;
}

function signalingMessage(
    offerId: string,
    { sdp = 'sdp', toId = 'receiver', traceId = `trace-${offerId}` } = {}
): ALMessage {
    return newALUnicastMessage(
        'sender',
        newALEventRoute(AppTopics.rtcSignaling, toId, 'offer'),
        toId,
        AppTopics.rtcSignaling,
        {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'sender',
            toId,
            sessionId: 'sender',
            token: 'fixture-ticket',
            signalType: 'Offer',
            offerId,
            payload: { description: { type: 'offer', sdp }, candidate: null }
        },
        { traceId }
    );
}
