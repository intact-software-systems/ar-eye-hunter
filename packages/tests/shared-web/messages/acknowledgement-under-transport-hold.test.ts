import { afterEach, describe, it, vi } from 'vitest';

import {
    ACK_UNDER_HOLD_CASES,
    expectAcknowledgedUnderHold,
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
});
