import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
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
    /** One entry per write to the transport: the envelopes it brought due. */
    readonly broughtDue: readonly (readonly ALMessage[])[];
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

    expect(fixture.broughtDue).toEqual([[offer]]);
});

it('leaves a signal held for another reason, or still refused, to its own retry', async () => {
    const fixture = await createHeldSignalFixture();
    fixture.refusalReasons.set('y-peer', INITIALIZING_REASON);
    await fixture.deliver(toSignalEnvelope('y-peer', 'offer-from-y'));
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    await fixture.deliver(offer);
    fixture.admittedPeerIds.add('y-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.broughtDue).toEqual([]);

    fixture.admittedPeerIds.add('z-peer');
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.broughtDue).toEqual([[offer]]);
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

    expect(fixture.broughtDue).toEqual([]);
});

it('keeps a hold while the peer cap is full and brings it due once a slot frees', async () => {
    const fixture = await createHeldSignalFixture(1);
    const offer = toSignalEnvelope('z-peer', 'offer-from-z');
    await fixture.deliver(offer);
    fixture.admittedPeerIds.add('x-peer').add('z-peer');
    expect(fixture.service.ensurePeerConnectionStarted('x-peer').right?.peer.peerId).toBe('x-peer');

    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.broughtDue).toEqual([]);

    fixture.service.removePeerIfPresent('x-peer');
    await fixture.service.writeHeldInboundSignalsDueNow(LAYOUT_REASON);
    expect(fixture.broughtDue).toEqual([[offer]]);
});

async function createHeldSignalFixture(maxPeerConnections?: number): Promise<HeldSignalFixture> {
    let connected: QRtcSignalingTransportInput | undefined;
    const signaler: QRtcSignalingTransport = {
        connect: async (input) => {
            connected = input;
        },
        send: async () => {}
    };
    const broughtDue: (readonly ALMessage[])[] = [];
    const service = new WebRtcConnectionService(signaler, {
        sessionId: SELF,
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 },
        dataChannelName: 'room',
        rtcSignalingTopicId: 'rtc',
        maxPeerConnections
    }, {
        faultPort: createPassThroughTransportFaultPort(),
        createOfferId: new DeterministicRtcOfferIds().createOfferId,
        nowEpochMs: () => Date.now(),
        writeRetainedSignalsDueNow: async (envelopes) => {
            broughtDue.push(envelopes);
            return envelopes;
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
        broughtDue,
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
