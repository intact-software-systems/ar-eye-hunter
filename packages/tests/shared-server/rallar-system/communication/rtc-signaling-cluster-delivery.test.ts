import { expect, it } from 'vitest';

import { installRtcSignalingWsTopic } from '@shared-server/rallar-system/communication/install-rtc-signaling-ws-topic.ts';
import type { LiveWsNotice, LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import { createServerIngressFixture } from '../../../shared/services/ws-queue-box-server-ingress-fixture.ts';

const scope = { applicationId: 'app', workspaceId: 'workspace' };

function signalingMessage(): ALMessage {
    return newALUnicastMessage(
        'sender',
        newALEventRoute(AppTopics.rtcSignaling, 'receiver', 'offer'),
        'receiver',
        AppTopics.rtcSignaling,
        {
            channel: 'RtcSignal',
            type: 'Signal',
            fromId: 'sender',
            toId: 'receiver',
            sessionId: 'sender',
            token: 'fixture-ticket',
            signalType: 'Offer',
            offerId: 'offer-1',
            payload: { description: { type: 'offer', sdp: 'sdp' }, candidate: null }
        }
    );
}

it.each([
    { recipientScope: scope, expectedLocalSends: 1 },
    { recipientScope: { applicationId: 'other', workspaceId: 'workspace' }, expectedLocalSends: 0 }
])('publishes one admitted RTC signal while sending only to a $recipientScope.applicationId recipient', async ({
    recipientScope,
    expectedLocalSends
}) => {
    const fixture = await createServerIngressFixture(
        undefined,
        'sender',
        (connection) => ({
            scope: connection.id === 'receiver' ? recipientScope : scope,
            expiresAtEpochMs: Date.now() + 60_000
        })
    );
    const receiver = new SimulatedWebSocket('ws://receiver');
    await receiver.open();
    fixture.server.addConnection(new ConnectionContext({ id: 'receiver', socket: receiver }));
    const notices: LiveWsNotice[] = [];
    const transport: LiveWsNoticeTransport = {
        publish: async (notice) => {
            notices.push(notice);
        },
        subscribe: async () => {}
    };
    installRtcSignalingWsTopic(fixture.service, {
        transport,
        channel: 'ws-channel',
        publisherId: 'publisher-a'
    }, Date.now);
    const message = signalingMessage();

    expect((await fixture.service.acceptIncomingMessage(message, 'sender')).right?.kind).toBe('admitted');
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]).toMatchObject({
        delivery: 'inline',
        scope,
        audience: { mode: 'peer', recipientSessionIds: ['receiver'] },
        message: { id: message.id, targets: message.targets, payload: message.payload }
    });
    expect(receiver.sent).toEqual(Array.from({ length: expectedLocalSends }, () => JSON.stringify(message)));
    expect(fixture.delivered).toEqual([message]);
});

it('keeps non-RTC unicast on the ordinary forwarding path', async () => {
    const fixture = await createServerIngressFixture(undefined, 'sender');
    const receiver = new SimulatedWebSocket('ws://receiver');
    await receiver.open();
    fixture.server.addConnection(new ConnectionContext({ id: 'receiver', socket: receiver }));
    const notices: LiveWsNotice[] = [];
    installRtcSignalingWsTopic(fixture.service, {
        transport: {
            publish: async (notice) => {
                notices.push(notice);
            },
            subscribe: async () => {}
        },
        channel: 'ws-channel',
        publisherId: 'publisher-a'
    }, Date.now);
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
    expect(notices).toEqual([]);
    expect(fixture.delivered).toEqual([]);
});
