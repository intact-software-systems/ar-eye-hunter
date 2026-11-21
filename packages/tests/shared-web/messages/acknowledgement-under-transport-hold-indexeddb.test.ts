import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';

import {
    ACK_AFTER_RECEIPT_EXHAUSTED_CASES,
    ACK_AGAINST_RETRY_SCHEDULE_CASES,
    ACK_UNDER_CONCURRENT_EVICTION_CASES,
    ACK_UNDER_HOLD_CASES,
    ACK_UNDER_HOLD_MESSAGE_TTL_MS,
    expectAckIgnoredAfterReceiptExhausted,
    expectAcknowledgedUnderHold,
    expectFailedAtReceiptExhaustion,
    expectRefusedPastAShortDeadline,
    openRtcHoldSender,
    openWsHoldSender
} from './acknowledgement-under-hold-fixture.ts';

describe('an acknowledgement that arrives while a transport hold drops another send, over IndexedDB stores', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(ACK_UNDER_HOLD_CASES)(
        'admits a %s ACK, records it and acknowledges the send (hold armed: %s, lane variable: %s)',
        async (carrier, armed, escalation) => {
            const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
            await expectAcknowledgedUnderHold(sender, armed, escalation);
        }
    );

    it.each(ACK_UNDER_CONCURRENT_EVICTION_CASES)(
        'acknowledges a %s send when a concurrent chain evicts an expired row the ACK read (hold armed: %s, lane variable: %s)',
        async (carrier, armed, escalation) => {
            const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
            await expectAcknowledgedUnderHold(sender, armed, escalation);
        }
    );

    it.each(ACK_AGAINST_RETRY_SCHEDULE_CASES)(
        'acknowledges a %s send whose ACK arrives inside the message deadline (hold armed: %s, lane variable: %s)',
        async (carrier, armed, escalation) => {
            const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
            await expectAcknowledgedUnderHold(sender, armed, escalation);
        }
    );

    it.each(ACK_AFTER_RECEIPT_EXHAUSTED_CASES)(
        'ignores a %s ACK that arrives after the receipt ran out of retries, inside the message deadline (hold armed: %s)',
        async (carrier, armed) => {
            const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
            await expectAckIgnoredAfterReceiptExhausted(sender, armed);
        }
    );

    it.each(['rtc', 'ws'] as const)('ends a %s send failed when its receipt runs out of retries, and keeps it failed past the deadline', async (carrier) => {
        const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
        await expectFailedAtReceiptExhaustion(sender);
    });

    // A stalled engine runs one batch per timeout, so a batch after a retry can hold the retry's repair beside the next
    // timer. A repair that runs first re-arms the receipt's deadline and that timer defers once, so each attempt after
    // the first may cost a second round: the receipt ends later than budget + 1 rounds, never later than 2 × budget + 1.
    it('a ws receipt whose retries run a whole timeout late still ends after its budget, later', async () => {
        const sender = await openWsHoldSender();
        const submission = sender.createMessage('submission', ACK_UNDER_HOLD_MESSAGE_TTL_MS);
        const handle = await sender.send(submission);
        await sender.drain();
        const receipt = await sender.readPendingAck(submission.id.msgId);
        if (receipt === undefined) {
            throw new Error('The submission must leave a receipt');
        }
        const { timeoutMs, maxAttempts } = receipt;
        const roundLimit = 4 * (maxAttempts + 1);

        let rounds = 0;
        while (handle.lifecycle().state !== 'failed' && rounds < roundLimit) {
            rounds += 1;
            await sender.advance(timeoutMs + 1);
            await sender.drain();
            await sender.settle();
        }

        const sends = TestWebSocket.instances.flatMap((socket) => socket.sent)
            .filter((frame) => JSON.parse(String(frame))?.id?.msgId === submission.id.msgId);
        expect(handle.lifecycle()).toMatchObject({
            state: 'failed',
            evidence: { reason: `The receipt ran out of retries after ${maxAttempts} of ${maxAttempts}.` }
        });
        expect(sends.length).toBeGreaterThanOrEqual(1);
        expect(sends.length - 1).toBeLessThanOrEqual(maxAttempts);
        expect(rounds).toBeGreaterThan(maxAttempts + 1);
        expect(rounds).toBeLessThanOrEqual(2 * maxAttempts + 1);
    });

    it.each(['rtc', 'ws'] as const)('refuses a %s ACK past a deadline that ends inside the retry schedule', async (carrier) => {
        const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
        await expectRefusedPastAShortDeadline(sender);
    });
});
