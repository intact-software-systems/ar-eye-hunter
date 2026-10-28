import { toRallarMessage } from '@shared-web/browser/messages/to-rallar-message.ts';
import { newALMulticastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { validateALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import { describe, expect, it } from 'vitest';
import { createBrowserMessageSenderFixture, toQueuedMessageAdmission } from './browser-message-sender-fixture.ts';

interface EnvelopeCarrier {
    enqueueOutboxIfAbsent(message: ALMessage, carrierGap: RtcCarrierGapAdmission): Promise<ALOutboundEnqueueResult>;
}

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const SEND = { typeId: 'app.ask.v1', payload: { text: 'ask' }, roomId: 'room' } as const;

describe('the trace of a browser send', () => {
    it('mints a grammar-valid trace per send when the send names none, and the handle exposes the envelope\'s', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const rtc = captureEnvelopes(fixture.middleware.middleware.rtcRxStreamer);

        const first = await fixture.sender.sendWs({ ...SEND, scope: 'room' }, undefined);
        const second = await fixture.sender.sendWs({ ...SEND, scope: 'room' }, undefined);
        const multicast = await fixture.sender.sendRtc(SEND, undefined);

        expect([first.traceId, second.traceId, multicast.traceId]).toEqual([
            ws[0].id.traceId,
            ws[1].id.traceId,
            rtc[0].id.traceId
        ]);
        expect(new Set([first.traceId, second.traceId, multicast.traceId]).size).toBe(3);
        for (const traceId of [first.traceId, second.traceId, multicast.traceId]) {
            expect(validateALTraceId(traceId)).toEqual([]);
        }
    });

    it('keeps the trace a send names on every carrier and audience', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const rtc = captureEnvelopes(fixture.middleware.middleware.rtcRxStreamer);
        const traceId = 'trace-from-an-http-mutation';

        const handles = [
            await fixture.sender.sendWs({ ...SEND, scope: 'room', traceId }, undefined),
            await fixture.sender.sendWs({ ...SEND, scope: 'principal', principalId: 'principal-b', traceId }, undefined),
            await fixture.sender.sendWs({ ...SEND, peerId: 'peer-b', traceId }, undefined),
            await fixture.sender.sendRtc({ ...SEND, traceId }, undefined)
        ];

        expect([...ws, ...rtc].map((message) => message.id.traceId)).toEqual([traceId, traceId, traceId, traceId]);
        expect(handles.map((handle) => handle.traceId)).toEqual([traceId, traceId, traceId, traceId]);
    });

    it.each([
        ['empty', ''],
        ['longer than 128 characters', 'a'.repeat(129)],
        ['outside the trace alphabet', 'trace id']
    ])('refuses a send whose trace is %s with a $.traceId issue before queueing', async (_label, traceId) => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const rtc = captureEnvelopes(fixture.middleware.middleware.rtcRxStreamer);

        const sendingWs = fixture.sender.sendWs({ ...SEND, scope: 'room', traceId }, undefined);
        const sendingRtc = fixture.sender.sendRtc({ ...SEND, traceId }, undefined);

        await expect(sendingWs).rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.traceId' })] });
        await expect(sendingRtc).rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.traceId' })] });
        expect([...ws, ...rtc]).toEqual([]);
        expect(fixture.registry.size()).toBe(0);
    });

    it('returns every issue of a send whose trace and correlation are both invalid', async () => {
        const fixture = createBrowserMessageSenderFixture();

        const sending = fixture.sender.sendWs({ ...SEND, scope: 'room', traceId: 'trace id', corrId: '' }, undefined);

        await expect(sending).rejects.toMatchObject({
            issues: expect.arrayContaining([
                expect.objectContaining({ path: '$.traceId' }),
                expect.objectContaining({ path: '$.corrId' })
            ])
        });
    });

    it('hands the receiver the sender\'s trace, and the receiver\'s reply carries it under the request\'s correlation', async () => {
        const sending = createBrowserMessageSenderFixture();
        const replying = createBrowserMessageSenderFixture();
        const sent = captureEnvelopes(sending.middleware.middleware.rtcRxStreamer);
        const replies = captureEnvelopes(replying.middleware.middleware.webSocketQueueBox);
        const request = await sending.sender.sendRtc({ ...SEND, corrId: 'corr-0' }, undefined);

        const received = toRallarMessage<{ text: string; }>(
            'rtc',
            sent[0],
            async (message, payload, options) => await replying.sender.sendReply(message, payload, options)
        );
        const reply = await received.reply({ answer: 42 });

        expect(request.traceId).toBe(sent[0].id.traceId);
        expect(received.traceId).toBe(request.traceId);
        expect(replies[0].id.traceId).toBe(request.traceId);
        expect(replies[0].actions).toEqual({ corrId: 'corr-0', replyToMsgId: request.msgId });
        expect(reply).toMatchObject({ traceId: request.traceId, corrId: 'corr-0', replyToMsgId: request.msgId });
    });

    it('replies to a request under the request\'s trace, never a fresh one', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const ws = captureEnvelopes(fixture.middleware.middleware.webSocketQueueBox);
        const request = newALMulticastMessage(
            'requester-1',
            newALRoute('room.ask', 'room', 'resource-1'),
            ROOM_REF,
            'app.ask.v1',
            { question: 'ping' },
            { traceId: 'trace-of-the-request' }
        );

        const handle = await fixture.sender.sendReply(request, { answer: 42 }, undefined);

        expect(ws[0].id.traceId).toBe('trace-of-the-request');
        expect(handle.traceId).toBe('trace-of-the-request');
    });
});

/** Records each envelope a carrier admits, in admission order. */
function captureEnvelopes(carrier: EnvelopeCarrier): ALMessage[] {
    const envelopes: ALMessage[] = [];
    carrier.enqueueOutboxIfAbsent = async (message: ALMessage) => {
        envelopes.push(message);
        return await Promise.resolve(toQueuedMessageAdmission(message));
    };
    return envelopes;
}
