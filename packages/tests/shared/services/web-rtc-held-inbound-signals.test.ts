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

/** What the service asked of the clock and the transport, as the transport and the clock saw it. */
interface HeldSignalTransport {
    /** One entry per write the transport accepted: the envelopes it brought due. */
    readonly broughtDue: (readonly ALMessage[])[];
    clockReads: number;
    /** Absent, the clock is the wall clock. */
    nowEpochMs: number | undefined;
    failNextWrite: boolean;
}

interface HeldSignalFixture {
    readonly service: WebRtcConnectionService;
    readonly transport: HeldSignalTransport;
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

    expect(fixture.transport.broughtDue).toEqual([[offer]]);
});

it('leaves a signal held for another reason, or still refused, to its own retry', async () => {
    const fixture = await createHeldSignalFixture();
    fixture.refusalReasons.set('y-peer', INITIALIZING_REASON);
    await fixture.deliver(toSignalEnvelope('y-peer', 'offer-from-y'));
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    await fixture.deliver(offer);
    fixture.admittedPeerIds.add('y-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.transport.broughtDue).toEqual([]);

    fixture.admittedPeerIds.add('z-peer');
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.transport.broughtDue).toEqual([[offer]]);
});

it('reads neither the clock nor the transport while nothing is held', async () => {
    const fixture = await createHeldSignalFixture();
    fixture.transport.clockReads = 0;

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.transport.clockReads).toBe(0);
    expect(fixture.transport.broughtDue).toEqual([]);
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

    expect(fixture.transport.broughtDue).toEqual([]);
});

it('holds one message id from two senders as two signals', async () => {
    const fixture = await createHeldSignalFixture();
    const fromZ = toSignalEnvelope('z-peer', 'shared-id');
    const fromY = toSignalEnvelope('y-peer', 'shared-id');
    await fixture.deliver(fromZ);
    await fixture.deliver(fromY);
    fixture.admittedPeerIds.add('z-peer').add('y-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.transport.broughtDue).toEqual([[fromZ, fromY]]);
});

it('forgets a held signal past its deadline', async () => {
    const fixture = await createHeldSignalFixture();
    await fixture.deliver(toSignalEnvelope('z-peer', 'offer-from-z'));
    fixture.admittedPeerIds.add('z-peer');
    fixture.transport.nowEpochMs = Date.now() + SIGNAL_TTL_MS + 1;

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.transport.broughtDue).toEqual([]);
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

    expect(fixture.transport.broughtDue).toEqual([envelopes.slice(1)]);
});

it('keeps the held signals when the transport fails to bring them due', async () => {
    const fixture = await createHeldSignalFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    await fixture.deliver(offer);
    fixture.admittedPeerIds.add('z-peer');
    fixture.transport.failNextWrite = true;

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.transport.broughtDue).toEqual([]);
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);

    expect(fixture.transport.broughtDue).toEqual([[offer]]);
});

async function createHeldSignalFixture(): Promise<HeldSignalFixture> {
    let connected: QRtcSignalingTransportInput | undefined;
    const signaler: QRtcSignalingTransport = {
        connect: async (input) => {
            connected = input;
        },
        send: async () => {}
    };
    const transport: HeldSignalTransport = { broughtDue: [], clockReads: 0, nowEpochMs: undefined, failNextWrite: false };
    const service = new WebRtcConnectionService(signaler, {
        sessionId: SELF,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc'
    }, {
        faultPort: createPassThroughTransportFaultPort(),
        createOfferId: new DeterministicRtcOfferIds().createOfferId,
        nowEpochMs: () => {
            transport.clockReads += 1;
            return transport.nowEpochMs ?? Date.now();
        },
        writeRetainedSignalsDueNow: async (envelopes) => {
            if (transport.failNextWrite) {
                transport.failNextWrite = false;
                throw new Error('storage unavailable');
            }
            transport.broughtDue.push(envelopes);
        }
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
        transport,
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
