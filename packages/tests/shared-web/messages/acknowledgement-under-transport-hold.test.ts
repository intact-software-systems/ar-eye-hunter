import { afterEach, describe, it, vi } from 'vitest';

import {
    ACK_AFTER_RECEIPT_EXHAUSTED_CASES,
    ACK_AGAINST_RETRY_SCHEDULE_CASES,
    ACK_UNDER_HOLD_CASES,
    expectAckIgnoredAfterReceiptExhausted,
    expectAcknowledgedUnderHold,
    expectFailedAtReceiptExhaustion,
    expectRefusedPastAShortDeadline,
    openRtcHoldSender,
    openWsHoldSender
} from './acknowledgement-under-hold-fixture.ts';

describe('an acknowledgement that arrives while a transport hold drops another send', () => {
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

    it.each(['rtc', 'ws'] as const)('refuses a %s ACK past a deadline that ends inside the retry schedule', async (carrier) => {
        const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
        await expectRefusedPastAShortDeadline(sender);
    });
});
