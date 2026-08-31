import { WebRtcHeartbeatService, type PingResult } from '@shared/services/web-rtc-heartbeat-service.ts';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type SimulatedNativeRtcDataChannel
} from './native-rtc-connection-fixture.ts';

interface HeartbeatRuntime {
    readonly service: WebRtcHeartbeatService;
    readonly channel: SimulatedNativeRtcDataChannel;
    readonly reports: PingResult[];
    readonly missedPeers: string[];
}

describe('WebRtcHeartbeatService', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('sends pings, responds to remote pings and resets the missed count on a measured pong', async () => {
        const runtime = await createHeartbeatRuntime(3);
        let now = 1_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        await vi.advanceTimersByTimeAsync(5);
        expect(runtime.channel.sent).toEqual(['{"type":"ping","pingType":"ping","ts":1000}']);

        await runtime.channel.receive('{"type":"ping","pingType":"ping","ts":123}');
        expect(runtime.channel.sent[1]).toBe('{"type":"ping","pingType":"pong","ts":123}');
        now = 1_042;
        await runtime.channel.receive('{"type":"ping","pingType":"pong","ts":1000}');
        expect(runtime.reports).toEqual([{ peerSessionId: 'peer-1', rttMsecs: 42, version: 2 }]);

        await vi.advanceTimersByTimeAsync(15);
        expect(runtime.missedPeers).toEqual([]);
        await vi.advanceTimersByTimeAsync(5);
        expect(runtime.missedPeers).toEqual(['peer-1']);
    });

    it('reports a missing peer after exactly the configured unanswered ping threshold', async () => {
        const runtime = await createHeartbeatRuntime(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(runtime.channel.sent).toHaveLength(2);
        expect(runtime.missedPeers).toEqual([]);
        await vi.advanceTimersByTimeAsync(5);
        expect(runtime.missedPeers).toEqual(['peer-1']);
        expect(runtime.channel.sent).toHaveLength(2);
    });

    it('stops reporting when the native data channel closes', async () => {
        const runtime = await createHeartbeatRuntime(2);
        await vi.advanceTimersByTimeAsync(5);
        const sentBeforeClose = [...runtime.channel.sent];
        await runtime.channel.close();
        await vi.advanceTimersByTimeAsync(50);
        expect(runtime.channel.sent).toEqual(sentBeforeClose);
        expect(runtime.missedPeers).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops periodic pings and incoming pong responses when explicitly stopped', async () => {
        const runtime = await createHeartbeatRuntime(2);
        runtime.service.stop();
        await runtime.channel.receive('{"type":"ping","pingType":"ping","ts":123}');
        await vi.advanceTimersByTimeAsync(50);
        expect(runtime.channel.sent).toEqual([]);
        expect(runtime.reports).toEqual([]);
        expect(runtime.missedPeers).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});

async function createHeartbeatRuntime(maxMissedPings: number): Promise<HeartbeatRuntime> {
    vi.useFakeTimers();
    const native = installNativeRtcRuntime();
    const fixture = createNativeRtcConnectionFixture({
        sessionId: 'self',
        token: 'fixture-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'heartbeat',
        rtcSignalingTopicId: 'rtc'
    }, native);
    const connected = fixture.service.ensurePeerConnectionStarted('peer-1', true);
    if (!connected.right) {
        throw new Error('Heartbeat fixture failed to establish its peer');
    }
    const nativePeer = fixture.nativePeer('peer-1');
    nativePeer.setConnected();
    const channel = nativePeer.channels[0];
    if (!channel) {
        throw new Error('Heartbeat fixture has no native data channel');
    }
    await channel.open();
    const reports: PingResult[] = [];
    const missedPeers: string[] = [];
    const service = new WebRtcHeartbeatService({
        sessionId: 'self',
        peerSessionId: 'peer-1',
        channel: connected.right.channel,
        maxMissedPings,
        pingFrequencyMsecs: 5
    });
    onTestFinished(() => {
        service.stop();
        fixture.dispose();
        native.dispose();
    });
    service.start({
        onHeartbeat: async (report) => {
            reports.push(report);
        },
        onMissedHeartbeat: async (peerId) => {
            missedPeers.push(peerId);
        }
    });
    return { service, channel, reports, missedPeers };
}
