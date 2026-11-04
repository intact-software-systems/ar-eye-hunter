import { expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { QRtcDataChannel } from '@shared/webrtc/qrtc-data-channel.ts';
import { QRtcPeerConnection } from '@shared/webrtc/qrtc-peer-connection.ts';

import { installNativeRtcRuntime } from '../native-rtc-connection-fixture.ts';

it('suppresses every held RTC native write until the same fault is explicitly released', async () => {
    const runtime = installNativeRtcRuntime();
    const faults = createScriptedTransportFaultPort();
    const fault = {
        faultId: 'hold',
        carrier: 'rtc',
        action: 'drop',
        remaining: 'until-cleared',
        match: { typeId: 'held', msgId: undefined, controlType: undefined }
    } as const;
    faults.inject(fault);
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        peerSessionId: 'peer',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    }, { createOfferId: crypto.randomUUID.bind(crypto) });
    const channel = new QRtcDataChannel(peer, { faultPort: faults, peerId: 'peer', dataChannelName: 'alm' });
    try {
        peer.connect();
        channel.connect(true);
        const native = runtime.createdConnections[0]!.channels[0]!;
        await native.open();
        const frame = JSON.stringify(newALUnicastMessage(
            'self',
            {
                topicId: 'topic',
                contextId: 'room',
                resourceId: 'original'
            },
            'peer',
            'held',
            {}
        ));
        for (let attempt = 0; attempt < 150; attempt += 1) {
            expect(channel.sendRaw(frame)).toMatchObject({ status: 'dropped' });
        }
        expect(native.sent).toEqual([]);
        faults.inject({ ...fault, remaining: 0 });
        expect(channel.sendRaw(frame)).toMatchObject({ status: 'sent' });
        expect(native.sent).toEqual([frame]);
    }
    finally {
        channel.reset();
        peer.reset();
        runtime.dispose();
    }
});

it('writes the frame a rewrite fault returns in place of the one the sender submitted', async () => {
    const runtime = installNativeRtcRuntime();
    const faults = createScriptedTransportFaultPort();
    faults.inject({
        faultId: 'strip',
        carrier: 'rtc',
        action: { rewrite: { kind: 'strip-proof' } },
        remaining: 1,
        match: { typeId: 'signed', msgId: undefined, controlType: undefined }
    });
    const peer = new QRtcPeerConnection({ send: async () => {} }, {
        sessionId: 'self',
        peerSessionId: 'peer',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        isPolite: false
    }, { createOfferId: crypto.randomUUID.bind(crypto) });
    const channel = new QRtcDataChannel(peer, { faultPort: faults, peerId: 'peer', dataChannelName: 'alm' });
    try {
        peer.connect();
        channel.connect(true);
        const native = runtime.createdConnections[0]!.channels[0]!;
        await native.open();
        const unsigned = newALUnicastMessage(
            'self',
            { topicId: 'topic', contextId: 'room', resourceId: 'signed' },
            'peer',
            'signed',
            {}
        );
        const frame = JSON.stringify({ ...unsigned, proof: { alg: 'ES256', keyId: 'key', signature: 'signature' } });

        expect(channel.sendRaw(frame)).toMatchObject({ status: 'sent' });
        expect(channel.sendRaw(frame)).toMatchObject({ status: 'sent' });
        expect(native.sent.map((sent) => JSON.parse(String(sent)))).toEqual([JSON.parse(JSON.stringify(unsigned)), JSON.parse(frame)]);
    }
    finally {
        channel.reset();
        peer.reset();
        runtime.dispose();
    }
});
