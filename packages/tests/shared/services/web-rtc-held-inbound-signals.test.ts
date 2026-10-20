import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { WEB_RTC_MAX_HELD_INBOUND_SIGNALS, WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import type {
    QRtcSignalingMessage,
    QRtcSignalingTransport,
    QRtcSignalingTransportInput
} from '@shared/webrtc/qrtc-signaling-contracts.ts';

import { installNativeRtcRuntime, type NativeRtcRuntime } from '../native-rtc-connection-fixture.ts';
import { DeterministicRtcOfferIds } from '../webrtc/deterministic-rtc-offer-ids.ts';

interface HeldSignalFixture {
    readonly service: WebRtcConnectionService;
    readonly nowEpochMs: ReturnType<typeof vi.fn<() => number>>;
    readonly writeRetainedSignalsDueNow: ReturnType<typeof vi.fn<(envelopes: readonly ALMessage[]) => Promise<void>>>;
    /** The peers the creation policy admits; every other peer is refused for its entry in `refusalReasons`. */
    readonly admittedPeerIds: Set<string>;
    readonly deniedPeerIds: Set<string>;
    readonly refusalReasons: Map<string, string>;
    deliver(envelope: ALMessage): Promise<void | 'retry'>;
}

const SELF = 'a-self';
const LAYOUT_REASON = 'stage-layout-mismatch';
const INITIALIZING_REASON = 'browser-runtime-initializing';
const SIGNAL_TTL_MS = 60_000;

let nativeRuntime: NativeRtcRuntime;

beforeEach(() => {
    nativeRuntime = installNativeRtcRuntime();
});

afterEach(() => {
    nativeRuntime.dispose();
    vi.restoreAllMocks();
});

it('brings due the held signals the adopted layout now admits, once', async () => {
    const fixture = await createHeldSignalFixture();
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    expect(await fixture.deliver(offer)).toBe('retry');
    fixture.admittedPeerIds.add('z-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.writeRetainedSignalsDueNow).toHaveBeenCalledTimes(1);
    expect(fixture.writeRetainedSignalsDueNow).toHaveBeenCalledWith([offer]);
});

it('leaves a signal held for another reason, or still refused, to its own retry', async () => {
    const fixture = await createHeldSignalFixture();
    fixture.refusalReasons.set('y-peer', INITIALIZING_REASON);
    await fixture.deliver(toSignalEnvelope('y-peer', 'offer-from-y'));
    await fixture.deliver(toSignalEnvelope('z-peer', 'offer-from-z'));
    fixture.admittedPeerIds.add('y-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.writeRetainedSignalsDueNow).not.toHaveBeenCalled();

    fixture.admittedPeerIds.add('z-peer');
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.writeRetainedSignalsDueNow).toHaveBeenCalledWith([expect.objectContaining({ id: expect.objectContaining({ msgId: 'offer-from-z' }) })]);
});

it('reads neither the clock nor the transport while nothing is held', async () => {
    const fixture = await createHeldSignalFixture();
    fixture.nowEpochMs.mockClear();

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.nowEpochMs).not.toHaveBeenCalled();
    expect(fixture.writeRetainedSignalsDueNow).not.toHaveBeenCalled();
});

it('forgets a held signal once it is delivered again, whether admitted, denied or reused', async () => {
    const fixture = await createHeldSignalFixture();
    const admitted = toSignalEnvelope('z-peer', 'offer-from-z');
    const denied = toSignalEnvelope('y-peer', 'offer-from-y');
    const reused = toSignalEnvelope('x-peer', 'offer-from-x');
    for (const envelope of [admitted, denied, reused]) {
        expect(await fixture.deliver(envelope)).toBe('retry');
    }

    fixture.admittedPeerIds.add('z-peer');
    expect(await fixture.deliver(admitted)).toBeUndefined();
    fixture.deniedPeerIds.add('y-peer');
    expect(await fixture.deliver(denied)).toBeUndefined();
    fixture.admittedPeerIds.add('x-peer');
    expect(fixture.service.ensurePeerConnectionStarted('x-peer').right?.peer.peerId).toBe('x-peer');
    fixture.admittedPeerIds.delete('x-peer');
    expect(await fixture.deliver(reused)).toBeUndefined();
    fixture.admittedPeerIds.add('y-peer');
    fixture.deniedPeerIds.delete('y-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.writeRetainedSignalsDueNow).not.toHaveBeenCalled();
});

it('forgets a held signal past its deadline', async () => {
    const fixture = await createHeldSignalFixture();
    await fixture.deliver(toSignalEnvelope('z-peer', 'offer-from-z'));
    fixture.admittedPeerIds.add('z-peer');
    fixture.nowEpochMs.mockReturnValue(Date.now() + SIGNAL_TTL_MS + 1);

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.writeRetainedSignalsDueNow).not.toHaveBeenCalled();
});

it('holds at most its cap, forgetting the oldest', async () => {
    const fixture = await createHeldSignalFixture();
    const envelopes = Array.from(
        { length: WEB_RTC_MAX_HELD_INBOUND_SIGNALS + 1 },
        (_, index) => toSignalEnvelope('z-peer', `offer-${index}`)
    );
    for (const envelope of envelopes) {
        await fixture.deliver(envelope);
    }
    fixture.admittedPeerIds.add('z-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.writeRetainedSignalsDueNow).toHaveBeenCalledWith(envelopes.slice(1));
});

it('keeps the held signals when the transport fails to bring them due', async () => {
    const fixture = await createHeldSignalFixture();
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    await fixture.deliver(offer);
    fixture.admittedPeerIds.add('z-peer');
    fixture.writeRetainedSignalsDueNow.mockRejectedValueOnce(new Error('storage unavailable'));

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(reported).toHaveBeenCalledTimes(1);
    expect(fixture.writeRetainedSignalsDueNow).toHaveBeenNthCalledWith(2, [offer]);
});

async function createHeldSignalFixture(): Promise<HeldSignalFixture> {
    let connected: QRtcSignalingTransportInput | undefined;
    const signaler: QRtcSignalingTransport = {
        connect: async (input) => {
            connected = input;
        },
        send: async () => {}
    };
    const nowEpochMs = vi.fn(() => Date.now());
    const writeRetainedSignalsDueNow = vi.fn(async (_envelopes: readonly ALMessage[]) => {});
    const service = new WebRtcConnectionService(signaler, {
        sessionId: SELF,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc'
    }, {
        faultPort: createPassThroughTransportFaultPort(),
        createOfferId: new DeterministicRtcOfferIds().createOfferId,
        nowEpochMs,
        writeRetainedSignalsDueNow
    });
    const admittedPeerIds = new Set<string>();
    const deniedPeerIds = new Set<string>();
    const refusalReasons = new Map<string, string>();
    service.setInboundPeerCreationPolicy(({ peerId }) => {
        if (admittedPeerIds.has(peerId)) {
            return 'allow';
        }
        return deniedPeerIds.has(peerId)
            ? 'deny'
            : { decision: 'retry', reason: refusalReasons.get(peerId) ?? LAYOUT_REASON };
    });
    service.setOutboundDialPolicy(({ peerId }) => admittedPeerIds.has(peerId));
    await service.connectSignaler();
    return {
        service,
        nowEpochMs,
        writeRetainedSignalsDueNow,
        admittedPeerIds,
        deniedPeerIds,
        refusalReasons,
        deliver: async (envelope) => await connected!.callbacks.onMessage(SELF, 'test-token', envelope)
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
