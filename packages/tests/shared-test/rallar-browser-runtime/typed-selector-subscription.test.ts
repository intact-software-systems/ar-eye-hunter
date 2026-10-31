import {
    beforeEach,
    expect,
    it
} from 'vitest';

import type { BlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { decodeBlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessage } from '@shared-web/browser/rallar.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';

import {
    events,
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);

const TOPIC_ID = 'room.alm-conformance';

const GRANTED_TOPIC_ID = 'room.alm-conformance-granted';

const COMBINED_TYPE_IDS = [
    'alm.conformance.rtc.aggregated-receipt',
    'alm.conformance.rtc.frozen-audience-membership'
] as const;

function toCombinedConfig(
    rallar: Readonly<{ typeId?: string; messageTypeIds?: readonly string[]; }>
): BlackBoxRallarConnectionConfig {
    return {
        connection: 'combined',
        actor: 'alice',
        roomId: 'room',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app',
            workspaceId: 'workspace',
            transport: 'messages.rtc',
            topicId: TOPIC_ID,
            messageSelector: { topicId: TOPIC_ID, typeId: undefined, access: 'members' },
            logoutOnClose: false,
            leaveRoomOnClose: false,
            ...rallar
        }
    } as const;
}

function toInboundMessage(transport: 'rtc' | 'ws', typeId: string, phase: string): RallarMessage<RallarMessagePayload> {
    const raw = newALUnicastMessage(
        'sender',
        { topicId: TOPIC_ID, contextId: 'room', resourceId: 'resource' },
        'receiver',
        typeId,
        { specimen: transport, phase }
    );
    return {
        transport,
        typeId: raw.payload.typeId,
        topicId: raw.route.topicId,
        contextId: 'room',
        resourceId: 'resource',
        senderId: 'sender',
        traceId: raw.id.traceId,
        payload: { specimen: transport, phase },
        raw,
        receivedAtEpochMs: 123,
        reply: unexpectedReply
    };
}

function unexpectedReply(): never {
    throw new Error('The selector scenario never replies.');
}

it('owns one WS topic selector and one RTC subscription per listed type until replacement or close', async () => {
    const runtime = await loadRuntime();
    // The connect's own type is one of the listed types, so the RTC list is de-duplicated.
    const config = toCombinedConfig({ typeId: COMBINED_TYPE_IDS[0], messageTypeIds: COMBINED_TYPE_IDS });
    await runtime.connect(config);
    expect(facade.records.typedChannelOpens).toEqual([]);
    expect(facade.records.wsMessageSubscriptions.map(([selector]) => selector)).toEqual([{ topicId: TOPIC_ID }]);
    expect(facade.records.rtcMessageSubscriptions.map(([selector]) => selector)).toEqual(
        COMBINED_TYPE_IDS.map((typeId) => ({ topicId: TOPIC_ID, typeId }))
    );
    // An outbound send needs no inbound subscription of its own: the connect's type list already names every
    // type the combined recipe receives, so a send opens no typed channel and adds no RTC subscription.
    await runtime.sendMessage({
        connection: 'combined',
        carrier: 'ws',
        typeId: 'another-generated-type',
        topicId: TOPIC_ID,
        payload: { specimen: 'outbound' },
        handleId: 'own-send',
        timeoutMs: 100
    });
    expect(facade.records.typedWsHandlers).toHaveLength(0);
    expect(facade.records.typedRtcHandlers).toHaveLength(0);
    expect(facade.records.rtcMessageSubscriptions).toHaveLength(COMBINED_TYPE_IDS.length);

    for (const phase of ['before-health', 'after-health']) {
        const deliveries = [
            ...facade.records.rtcMessageSubscriptions.map(([selector, receive]) => ({
                receive,
                message: toInboundMessage('rtc', String((selector as { typeId: string; }).typeId), phase)
            })),
            ...facade.records.wsMessageSubscriptions.map(([, receive]) => ({
                receive,
                message: toInboundMessage('ws', `scenario.ws.${phase}`, phase)
            }))
        ];
        for (const { receive, message } of deliveries) {
            await receive(message);
            expect(events.filter((event) => event.kind === 'message').at(-1)?.data).toEqual({
                msgId: message.raw.id.msgId,
                typeId: message.typeId,
                topicId: TOPIC_ID,
                transport: message.transport,
                payload: message.payload,
                traceId: message.raw.id.traceId,
                corrId: message.raw.id.msgId
            });
        }
        if (phase === 'before-health') {
            expect(await runtime.health()).toMatchObject({
                connection: 'combined',
                document: { timeOrigin: 1_700_000_000_000.25, origin: 'https://runtime.example.test' }
            });
        }
    }
    await runtime.connect(config);
    expect(facade.records.rtcMessageUnsubscribeCount).toBe(COMBINED_TYPE_IDS.length);
    expect(facade.records.wsMessageUnsubscribeCount).toBe(1);
    await runtime.close();
    expect(facade.records.rtcMessageUnsubscribeCount).toBe(2 * COMBINED_TYPE_IDS.length);
    expect(facade.records.wsMessageUnsubscribeCount).toBe(2);
});

it('subscribes a topic-only selector without listed types to WS plus RTC for the connect type alone', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(toCombinedConfig({ typeId: 'own-type' }));
    expect(facade.records.wsMessageSubscriptions.map(([selector]) => selector)).toEqual([{ topicId: TOPIC_ID }]);
    expect(facade.records.rtcMessageSubscriptions.map(([selector]) => selector)).toEqual([
        { topicId: TOPIC_ID, typeId: 'own-type' }
    ]);
    await runtime.close();
    expect(facade.records.rtcMessageUnsubscribeCount).toBe(1);
    expect(facade.records.wsMessageUnsubscribeCount).toBe(1);
});

/** The wire form a recipe's connect carries, decoded as the page decodes it. */
function toGrantedConfig(messageSelector: Readonly<Record<string, string>>): BlackBoxRallarConnectionConfig {
    return decodeBlackBoxRallarConnectionConfig({
        connection: 'granted',
        actor: 'bob',
        roomId: 'room',
        roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'bob',
            password: 'secret',
            applicationId: 'app',
            workspaceId: 'workspace',
            transport: 'messages.ws',
            typeId: 'alm.conformance.ws.subscription-delivery',
            topicId: GRANTED_TOPIC_ID,
            messageSelector,
            logoutOnClose: false,
            leaveRoomOnClose: false
        }
    });
}

it('a granted selector opens a granted room channel; an absent access opens members', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(toGrantedConfig({ topicId: GRANTED_TOPIC_ID, access: 'granted' }));
    expect(await runtime.subscribeTopic({ connection: 'granted', subscriptionId: 't1', timeoutMs: 100 }))
        .toEqual({ subscriptionId: 't1', status: 'active' });
    expect(facade.records.typedChannelOpens.map(({ typeId, topicId, access }) => ({ typeId, topicId, access })))
        .toEqual([{ typeId: 'alm.conformance.ws.subscription-delivery', topicId: GRANTED_TOPIC_ID, access: 'granted' }]);
    await runtime.close();

    const members = toGrantedConfig({ topicId: GRANTED_TOPIC_ID });
    expect(members.rallar.messageSelector).toEqual({ topicId: GRANTED_TOPIC_ID, typeId: undefined, access: 'members' });
    await runtime.connect(members);
    await runtime.sendMessage({
        connection: 'granted',
        carrier: 'ws',
        typeId: 'alm.conformance.ws.subscription-delivery',
        topicId: GRANTED_TOPIC_ID,
        payload: { specimen: 'members' },
        handleId: 'members-send',
        timeoutMs: 100
    });
    expect(facade.records.typedChannelOpens.at(-1)).toMatchObject({ topicId: GRANTED_TOPIC_ID, access: 'members' });
    await expect(runtime.subscribeTopic({ connection: 'granted', subscriptionId: 't2', timeoutMs: 100 })).rejects
        .toThrow('messages.subscribe needs a connection whose message selector names a granted topic.');
    expect(() => toGrantedConfig({ topicId: GRANTED_TOPIC_ID, access: 'public' })).toThrow(
        'Rallar connection option has an unsupported value.'
    );
});

it('keeps each token under its subscriptionId beside the socket generation, renews an ended one, until the page closes', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(toGrantedConfig({ topicId: GRANTED_TOPIC_ID, access: 'granted' }));
    await runtime.subscribeTopic({ connection: 'granted', subscriptionId: 't1', timeoutMs: 100 });
    facade.behavior.typedSubscribeAnswer.mockReturnValue('refused');
    await runtime.subscribeTopic({ connection: 'granted', subscriptionId: 't2', timeoutMs: 100 });

    expect(await runtime.unsubscribeTopic({ connection: 'granted', subscriptionId: 't1' }))
        .toEqual({ subscriptionId: 't1', status: 'lapsed' });
    expect(await runtime.readTopicSubscriptions({ connection: 'granted' })).toEqual({
        connectionGenerationId: 'generation-1',
        subscriptions: [
            { subscriptionId: 't1', topicId: GRANTED_TOPIC_ID, status: 'lapsed' },
            { subscriptionId: 't2', topicId: GRANTED_TOPIC_ID, status: 'refused' }
        ]
    });
    facade.behavior.typedSubscribeAnswer.mockReturnValue('active');
    await runtime.subscribeTopic({ connection: 'granted', subscriptionId: 't2', timeoutMs: 100 });
    await expect(runtime.subscribeTopic({ connection: 'granted', subscriptionId: 't2', timeoutMs: 100 })).rejects
        .toThrow('messages.subscribe names subscriptionId t2, whose token is still active.');
    expect((await runtime.readTopicSubscriptions({ connection: 'granted' })).subscriptions.map(({ status }) => status))
        .toEqual(['lapsed', 'active']);
    await expect(runtime.unsubscribeTopic({ connection: 'granted', subscriptionId: 't3' })).rejects
        .toThrow('messages.unsubscribe names subscriptionId t3, which the page does not hold.');
    facade.behavior.readConnectionGenerationId.mockResolvedValue(undefined);
    expect(await runtime.readTopicSubscriptions({ connection: 'granted' }))
        .toMatchObject({ connectionGenerationId: null });

    await runtime.close();
    await runtime.connect(toGrantedConfig({ topicId: GRANTED_TOPIC_ID, access: 'granted' }));
    expect(await runtime.readTopicSubscriptions({ connection: 'granted' }))
        .toEqual({ connectionGenerationId: null, subscriptions: [] });
});
