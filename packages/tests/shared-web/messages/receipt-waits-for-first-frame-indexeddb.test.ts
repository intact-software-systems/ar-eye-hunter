import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ACK_UNDER_HOLD_MESSAGE_TTL_MS,
    openRtcHoldSender,
    openWsHoldSender,
    runAckTimeoutClaimsToExhaustion
} from './acknowledgement-under-hold-fixture.ts';

describe('a receipt waits for its first frame on the browser carriers, over IndexedDB stores', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['rtc', 'ws'] as const)(
        'a %s send is not failed while its first frame is held past its receipt budget, and leaves once when the hold lifts',
        async (carrier) => {
            const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
            sender.faults.inject(sender.hold);
            const submission = sender.createMessage('submission', ACK_UNDER_HOLD_MESSAGE_TTL_MS);
            const handle = await sender.send(submission);
            await sender.drain();
            // The hold fixture records no admission on the handle, so a send it holds stays `submitted`.
            const heldState = handle.lifecycle().state;
            await runAckTimeoutClaimsToExhaustion(sender, submission.id.msgId);
            expect(handle.lifecycle().state).toBe(heldState);
            expect(await sender.readPendingAck(submission.id.msgId)).toMatchObject({ attempts: 0 });
            expect(sender.readSentFrames(submission.id.msgId)).toEqual([]);

            sender.faults.inject({ ...sender.hold, remaining: 0 });
            await sender.advance(100);
            await sender.drain();
            await sender.settle();
            expect(sender.readSentFrames(submission.id.msgId)).toHaveLength(1);
            expect(await sender.readPendingAck(submission.id.msgId)).toMatchObject({ attempts: 0 });
        }
    );
});
