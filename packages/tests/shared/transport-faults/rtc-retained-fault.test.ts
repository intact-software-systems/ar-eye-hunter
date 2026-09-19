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
    });
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
