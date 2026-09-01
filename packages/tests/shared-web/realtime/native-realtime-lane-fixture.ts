import type { QRtcPeerDto } from '@shared/services/web-rtc-connection-service.ts';
import type { QRtcDataChannel, RtcDataChannelFlowControlPolicy } from '@shared/webrtc/qrtc-data-channel.ts';
import { onTestFinished } from 'vitest';
import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type SimulatedNativeRtcDataChannel
} from '../../shared/native-rtc-connection-fixture.ts';

export interface NativeRealtimeLaneFixture {
    readonly peer: QRtcPeerDto;
    readonly channel: QRtcDataChannel;
    readonly native: SimulatedNativeRtcDataChannel;
}

export interface NativeRealtimeLaneOptions {
    readonly open?: boolean;
    readonly flowControl?: RtcDataChannelFlowControlPolicy;
}

/** Builds actual peer/channel owners and drives their native lane state. */
export async function createNativeRealtimeLaneFixture(
    peerId: string,
    laneId: string,
    options: NativeRealtimeLaneOptions = {}
): Promise<NativeRealtimeLaneFixture> {
    const runtime = installNativeRtcRuntime();
    const fixture = createNativeRtcConnectionFixture({
        sessionId: 'session-1',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 },
        dataChannelName: 'reliable',
        dataChannelLanes: [{ id: laneId, label: laneId, flowControl: options.flowControl }],
        rtcSignalingTopicId: 'rtc'
    }, runtime);
    onTestFinished(() => {
        fixture.dispose();
        runtime.dispose();
    });
    fixture.service.ensurePeerConnectionStarted(peerId, true);
    const peer = fixture.service.readPeer(peerId);
    const channel = peer?.channels.get(laneId);
    const native = fixture.nativePeer(peerId).channels.find((candidate) => candidate.label === laneId);
    if (!peer || !channel || !native) {
        throw new Error(`Native RTC lane ${peerId}/${laneId} was not created`);
    }
    if (options.open !== false) {
        await native.open();
    }
    return { peer, channel, native };
}
