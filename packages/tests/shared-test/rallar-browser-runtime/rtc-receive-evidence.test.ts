import { beforeEach, expect, it } from 'vitest';

import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';

import { events, facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(resetFacade);

it.each([
    { explicitSelector: false, deliveries: 1 },
    { explicitSelector: true, deliveries: 1 },
    { explicitSelector: false, deliveries: 2 },
    { explicitSelector: true, deliveries: 2 }
])('counts $deliveries actual SDK arrivals with explicit selector $explicitSelector', async ({ explicitSelector, deliveries }) => {
    const runtime = await loadRuntime();
    await runtime.connect({
        connection: 'receiver',
        roomId: 'room',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app',
            workspaceId: 'workspace',
            transport: 'messages.rtc',
            typeId: 'sample',
            topicId: 'samples',
            ...(explicitSelector ? { messageSelector: { typeId: 'sample', topicId: 'samples' } } : {})
        }
    });
    const message = toReceivedMessage();
    // Repeated SDK deliveries of the same msgId remain visible; only the duplicate recording path is removed.
    for (let delivery = 0; delivery < deliveries; delivery++) {
        for (const [, receive] of facade.records.rtcMessageSubscriptions) {
            await receive(message);
        }
        for (const receive of facade.records.typedRtcHandlers) {
            await receive(message.payload, message);
        }
    }
    const arrivals = events.filter((event) => event.kind === 'message');
    expect(arrivals).toHaveLength(deliveries);
    expect(arrivals[0]).toMatchObject({
        topic: 'rallar.browser.messages.rtc.message',
        peerId: 'session-1',
        remotePeerId: 'sender',
        senderId: 'sender',
        data: { msgId: message.raw.id.msgId, typeId: 'sample', payload: { sequence: 7 } }
    });
    const recorder = createDefaultRallarBlackBoxBrowserTestRuntime();
    for (const event of events) {
        recorder.receiveRallarBrowserEvent({
            ...event,
            roomRef: event.roomRef === undefined ? undefined : { ...event.roomRef },
            scope: event.scope === undefined ? undefined : { ...event.scope }
        });
    }
    expect(await recorder.execute({ kind: 'stats' })).toMatchObject({
        ok: true,
        value: { counters: { messages: deliveries } }
    });
    await runtime.close();
    expect(
        facade.records.typedUnsubscribeCount + facade.records.rtcMessageUnsubscribeCount +
            facade.records.wsMessageUnsubscribeCount
    ).toBe(2);
});

function toReceivedMessage(): RallarMessage<RallarMessagePayload> {
    const raw = newALUnicastMessage('sender', { topicId: 'samples', contextId: 'room', resourceId: 'one' }, 'session-1', 'sample', { sequence: 7 });
    return {
        transport: 'rtc',
        senderId: 'sender',
        typeId: 'sample',
        topicId: 'samples',
        roomId: 'room',
        contextId: 'room',
        resourceId: 'one',
        traceId: raw.id.traceId,
        payload: { sequence: 7 },
        raw,
        receivedAtEpochMs: 123,
        reply: async () => {
            throw new Error('This delivery does not request a reply.');
        }
    };
}
