import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ACK_UNDER_HOLD_MESSAGE_TTL_MS,
    advanceAndRun,
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
            await runAckTimeoutClaimsToExhaustion(sender, submission.id.msgId);
            // The hold fixture records no admission on the handle, so a send it holds reads `submitted`.
            expect(handle.lifecycle().state).toBe('submitted');
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

    it.each(['rtc', 'ws'] as const)(
        'a %s send whose first frame is held to its deadline reads submitted until then and expired after it, and nothing leaves once the hold lifts',
        async (carrier) => {
            const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
            sender.faults.inject(sender.hold);
            const submission = sender.createMessage('submission', ACK_UNDER_HOLD_MESSAGE_TTL_MS);
            const msgId = submission.id.msgId;
            const handle = await sender.send(submission);
            await sender.drain();
            const expiresAtMs = handle.lifecycle().expiresAtMs!;
            await runAckTimeoutClaimsToExhaustion(sender, msgId);

            await advanceAndRun(sender, expiresAtMs - 1 - Date.now());
            expect(handle.lifecycle().state).toBe('submitted');
            await advanceAndRun(sender, 2);
            expect(handle.lifecycle()).toMatchObject({ state: 'expired', evidence: { failure: { kind: 'expired' } } });
            expect(await handle.wait({ timeoutMs: 10 })).toMatchObject({ status: 'settled', lifecycle: { state: 'expired' } });
            expect(await sender.readPendingAck(msgId)).toBeUndefined();

            await advanceAndRun(sender, ACK_UNDER_HOLD_MESSAGE_TTL_MS);
            expect(await sender.readPendingAck(msgId)).toBeUndefined();
            sender.faults.inject({ ...sender.hold, remaining: 0 });
            await advanceAndRun(sender, 100);
            expect(sender.readSentFrames(msgId)).toEqual([]);
        }
    );
});
