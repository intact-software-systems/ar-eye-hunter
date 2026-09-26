import {
    beforeEach,
    expect,
    it
} from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';

import {
    events,
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);

const TOPIC_ID = 'room.alm-conformance';

const COMBINED_TYPE_IDS = [
    'alm.conformance.rtc.aggregated-receipt',
    'alm.conformance.rtc.frozen-audience-membership'
] as const;

function toCombinedConfig(
    rallar: Readonly<{ typeId?: string; messageTypeIds?: readonly string[]; }>
) {
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
            messageSelector: { topicId: TOPIC_ID },
            logoutOnClose: false,
            leaveRoomOnClose: false,
            ...rallar
        }
    } as const;
}

function toInboundMessage(transport: 'rtc' | 'ws', typeId: string, phase: string) {
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
        payload: { specimen: transport, phase },
        raw,
        receivedAtEpochMs: 123
    };
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
                payload: message.payload
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
