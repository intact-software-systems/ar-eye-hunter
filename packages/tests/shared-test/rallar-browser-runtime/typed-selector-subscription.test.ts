import { beforeEach, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';

import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);

it('owns one canonical topic selector on both carriers until replacement or close', async () => {
    const runtime = await loadRuntime();
    const config = {
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
            typeId: 'required-default',
            topicId: 'room.alm-conformance',
            messageSelector: { topicId: 'room.alm-conformance' },
            logoutOnClose: false,
            leaveRoomOnClose: false
        }
    } as const;
    await runtime.connect(config);
    expect(facade.records.typedChannelOpens).toEqual([]);
    expect(facade.records.rtcMessageSubscriptions).toHaveLength(1);
    expect(facade.records.wsMessageSubscriptions).toHaveLength(1);
    await runtime.sendMessage({
        connection: 'combined',
        carrier: 'ws',
        typeId: 'another-generated-type',
        topicId: 'room.alm-conformance',
        payload: { specimen: 'outbound' },
        handleId: 'own-send',
        timeoutMs: 100
    });
    expect(facade.records.typedWsHandlers).toHaveLength(0);
    expect(facade.records.typedRtcHandlers).toHaveLength(0);

    for (
        const [transport, subscriptions] of [
            ['rtc', facade.records.rtcMessageSubscriptions],
            ['ws', facade.records.wsMessageSubscriptions]
        ] as const
    ) {
        const [selector, receive] = subscriptions[0];
        expect(selector).toEqual({ topicId: 'room.alm-conformance' });
        const raw = newALUnicastMessage(
            'sender',
            {
                topicId: 'room.alm-conformance',
                contextId: 'room',
                resourceId: 'resource'
            },
            'receiver',
            `scenario.${transport}`,
            { specimen: transport }
        );
        await receive({
            transport,
            typeId: raw.payload.typeId,
            topicId: raw.route.topicId,
            contextId: 'room',
            resourceId: 'resource',
            senderId: 'sender',
            payload: { specimen: transport },
            raw,
            receivedAtEpochMs: 123
        });
        expect(events.filter((event) => event.kind === 'message').at(-1)?.data).toEqual({
            msgId: raw.id.msgId,
            typeId: `scenario.${transport}`,
            topicId: 'room.alm-conformance',
            transport,
            payload: { specimen: transport }
        });
    }
    await runtime.connect(config);
    expect(facade.records.rtcMessageUnsubscribeCount).toBe(1);
    expect(facade.records.wsMessageUnsubscribeCount).toBe(1);
    await runtime.close();
    expect(facade.records.rtcMessageUnsubscribeCount).toBe(2);
    expect(facade.records.wsMessageUnsubscribeCount).toBe(2);
});
