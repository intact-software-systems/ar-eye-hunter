import { afterEach, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeRtcSignalingEnvelope } from '@shared/webrtc/decode-rtc-signaling-message.ts';
import { HeldInboundRtcSignals, MAX_HELD_INBOUND_RTC_SIGNALS } from '@shared/webrtc/held-inbound-rtc-signals.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/qrtc-signaling-contracts.ts';

/** What the holds asked of the clock and the transport, as the transport and the clock saw it. */
interface HeldSignalTransport {
    /** One entry per write the transport accepted: the envelopes it was asked to bring due. */
    readonly requested: (readonly ALMessage[])[];
    clockReads: number;
    /** Envelopes whose retained row is claimed elsewhere, so a write does not bring them due. */
    readonly claimedMsgIds: Set<string>;
    /** Absent, the clock is the wall clock. */
    nowEpochMs: number | undefined;
    failNextWrite: boolean;
}

interface HeldSignalsFixture {
    readonly holds: HeldInboundRtcSignals;
    readonly transport: HeldSignalTransport;
    /** The senders a delivery would now admit. */
    readonly admittedSenderIds: Set<string>;
    hold(envelope: ALMessage, reason?: string): void;
    writeDueNow(reason?: string): Promise<void>;
}

const SELF = 'a-self';
const LAYOUT_REASON = 'stage-layout-mismatch';
const INITIALIZING_REASON = 'browser-runtime-initializing';
const SIGNAL_TTL_MS = 60_000;

afterEach(() => {
    vi.restoreAllMocks();
});

it('brings due an admitted hold of its reason once, and leaves holds of another reason', async () => {
    const fixture = createHeldSignalsFixture();
    const layoutHeld = toSignalEnvelope('z-peer', 'offer-from-z');
    fixture.hold(layoutHeld);
    fixture.hold(toSignalEnvelope('y-peer', 'offer-from-y'), INITIALIZING_REASON);
    fixture.admittedSenderIds.add('z-peer').add('y-peer');

    await fixture.writeDueNow();
    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([[layoutHeld]]);
});

it('leaves a hold the delivery would still refuse', async () => {
    const fixture = createHeldSignalsFixture();
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    fixture.hold(offer);

    await fixture.writeDueNow();
    expect(fixture.transport.requested).toEqual([]);

    fixture.admittedSenderIds.add('z-peer');
    await fixture.writeDueNow();
    expect(fixture.transport.requested).toEqual([[offer]]);
});

it('reads neither the clock nor the transport while nothing of its reason is held', async () => {
    const fixture = createHeldSignalsFixture();
    fixture.hold(toSignalEnvelope('z-peer', 'offer-from-z'), INITIALIZING_REASON);
    fixture.transport.clockReads = 0;

    await fixture.writeDueNow();

    expect(fixture.transport.clockReads).toBe(0);
    expect(fixture.transport.requested).toEqual([]);
});

it('forgets a hold once its signal is delivered again', async () => {
    const fixture = createHeldSignalsFixture();
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    fixture.hold(offer);
    fixture.admittedSenderIds.add('z-peer');

    fixture.holds.forget(offer);
    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([]);
});

it('holds one message id from two senders as two signals', async () => {
    const fixture = createHeldSignalsFixture();
    const fromZ = toSignalEnvelope('z-peer', 'shared-id');
    const fromY = toSignalEnvelope('y-peer', 'shared-id');
    fixture.hold(fromZ);
    fixture.hold(fromY);
    fixture.admittedSenderIds.add('z-peer').add('y-peer');

    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([[fromZ, fromY]]);
});

it('forgets a hold past its deadline', async () => {
    const fixture = createHeldSignalsFixture();
    fixture.hold(toSignalEnvelope('z-peer', 'offer-from-z'));
    fixture.admittedSenderIds.add('z-peer');
    fixture.transport.nowEpochMs = Date.now() + SIGNAL_TTL_MS + 1;

    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([]);
});

it('holds at most its cap, forgetting the oldest', async () => {
    const fixture = createHeldSignalsFixture();
    const envelopes = Array.from(
        { length: MAX_HELD_INBOUND_RTC_SIGNALS + 1 },
        (_, index) => toSignalEnvelope('z-peer', `offer-${index}`)
    );
    for (const envelope of envelopes) {
        fixture.hold(envelope);
    }
    fixture.admittedSenderIds.add('z-peer');

    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([envelopes.slice(1)]);
});

it('keeps the holds when the transport fails to bring them due', async () => {
    const fixture = createHeldSignalsFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    fixture.hold(offer);
    fixture.admittedSenderIds.add('z-peer');
    fixture.transport.failNextWrite = true;

    await fixture.writeDueNow();
    expect(fixture.transport.requested).toEqual([]);
    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([[offer]]);
});

it('keeps the hold of a signal whose row the write could not bring due', async () => {
    const fixture = createHeldSignalsFixture();
    const broughtDue = toSignalEnvelope('z-peer', 'offer-from-z');
    const claimed = toSignalEnvelope('y-peer', 'offer-from-y');
    fixture.hold(broughtDue);
    fixture.hold(claimed);
    fixture.admittedSenderIds.add('z-peer').add('y-peer');
    fixture.transport.claimedMsgIds.add('offer-from-y');

    await fixture.writeDueNow();
    await fixture.writeDueNow();

    expect(fixture.transport.requested).toEqual([[broughtDue, claimed], [claimed]]);
});

function createHeldSignalsFixture(): HeldSignalsFixture {
    const transport: HeldSignalTransport = {
        requested: [],
        clockReads: 0,
        claimedMsgIds: new Set(),
        nowEpochMs: undefined,
        failNextWrite: false
    };
    const holds = new HeldInboundRtcSignals({
        nowEpochMs: () => {
            transport.clockReads += 1;
            return transport.nowEpochMs ?? Date.now();
        },
        writeRetainedSignalsDueNow: async (envelopes) => {
            if (transport.failNextWrite) {
                transport.failNextWrite = false;
                throw new Error('storage unavailable');
            }
            transport.requested.push(envelopes);
            return envelopes.filter((envelope) => !transport.claimedMsgIds.has(envelope.id.msgId));
        }
    });
    const admittedSenderIds = new Set<string>();
    return {
        holds,
        transport,
        admittedSenderIds,
        hold: (envelope, reason = LAYOUT_REASON) => holds.hold({ envelope, signal: decodeRtcSignalingEnvelope(envelope).right!, reason }),
        writeDueNow: (reason = LAYOUT_REASON) => holds.writeDueNow(reason, (signal) => admittedSenderIds.has(signal.fromId))
    };
}

function toSignalEnvelope(senderId: string, msgId: string): ALMessage {
    const signal: QRtcSignalingMessage = {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: senderId,
        toId: SELF,
        sessionId: senderId,
        token: 'test-token',
        signalType: 'Offer',
        offerId: msgId,
        payload: { description: { type: 'offer', sdp: `${msgId}-sdp` }, candidate: null }
    };
    const message = newALUnicastMessage(senderId, newALEventRoute('rtc', SELF), SELF, 'rtc', signal, {
        ttlMs: SIGNAL_TTL_MS
    });
    return { ...message, id: { ...message.id, msgId } };
}
