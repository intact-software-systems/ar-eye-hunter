import { WebRtcHeartbeatService } from '@shared/services/WebRtcHeartbeatService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('WebRtcHeartbeatService', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('sends pings, replies to remote pings, and reports RTT on pong', async () => {
        vi.useFakeTimers();

        const channel = createDataChannelHarness();
        let now = 1_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);

        const onHeartbeat = vi.fn(async () => {
        });
        const onMissedHeartbeat = vi.fn(async () => {
        });
        const service = new WebRtcHeartbeatService({
            sessionId: 'self',
            peerSessionId: 'peer-1',
            channel: channel.channel as never,
            maxMissedPings: 3,
            pingFrequencyMsecs: 10
        });

        service.start({
            onHeartbeat,
            onMissedHeartbeat
        });

        expect(channel.messageType).toBe('ping');

        await vi.advanceTimersByTimeAsync(10);

        expect(channel.sentJsonStrings).toHaveLength(1);
        expect(JSON.parse(channel.sentJsonStrings[0])).toEqual({
            type: 'ping',
            pingType: 'ping',
            ts: 1_000
        });

        await channel.onMessageCallback?.onMessage({
            type: 'ping',
            pingType: 'ping',
            ts: 123
        });

        expect(JSON.parse(channel.sentJsonStrings[1])).toEqual({
            type: 'ping',
            pingType: 'pong',
            ts: 123
        });

        now = 1_042;
        await channel.onMessageCallback?.onMessage({
            type: 'ping',
            pingType: 'pong',
            ts: 1_000
        });

        expect(onHeartbeat).toHaveBeenCalledOnce();
        expect(onHeartbeat).toHaveBeenCalledWith({
            peerSessionId: 'peer-1',
            rttMsecs: 42,
            version: 2
        });
        expect(onMissedHeartbeat).not.toHaveBeenCalled();
        expect((service as any).status.missedPings).toBe(0);
    });

    it('triggers the missed-heartbeat callback after the configured threshold', async () => {
        vi.useFakeTimers();

        const channel = createDataChannelHarness();
        const onMissedHeartbeat = vi.fn(async () => {
        });
        const service = new WebRtcHeartbeatService({
            sessionId: 'self',
            peerSessionId: 'peer-1',
            channel: channel.channel as never,
            maxMissedPings: 2,
            pingFrequencyMsecs: 5
        });

        service.start({
            onHeartbeat: async () => {
            },
            onMissedHeartbeat
        });

        await vi.advanceTimersByTimeAsync(5);
        await vi.advanceTimersByTimeAsync(5);

        expect(channel.sentJsonStrings).toHaveLength(2);
        expect((service as any).status.missedPings).toBe(2);

        await vi.advanceTimersByTimeAsync(5);

        expect(onMissedHeartbeat).toHaveBeenCalledOnce();
        expect(onMissedHeartbeat).toHaveBeenCalledWith('peer-1');
        expect(channel.sentJsonStrings).toHaveLength(2);
    });

    it('stops its interval when the data channel closes', async () => {
        vi.useFakeTimers();

        const channel = createDataChannelHarness();
        const service = new WebRtcHeartbeatService({
            sessionId: 'self',
            peerSessionId: 'peer-1',
            channel: channel.channel as never,
            maxMissedPings: 2,
            pingFrequencyMsecs: 5
        });

        service.start({
            onHeartbeat: async () => {
            },
            onMissedHeartbeat: async () => {
            }
        });

        await vi.advanceTimersByTimeAsync(5);
        expect(channel.sentJsonStrings).toHaveLength(1);

        channel.setOpen(false);
        await vi.advanceTimersByTimeAsync(5);

        expect(channel.sentJsonStrings).toHaveLength(1);
        expect((service as any).status.pingInterval).toBeUndefined();
        expect(channel.messageCallbackCount).toBe(0);
    });

    it('removes its message callback when stopped', () => {
        const channel = createDataChannelHarness();
        const service = new WebRtcHeartbeatService({
            sessionId: 'self',
            peerSessionId: 'peer-1',
            channel: channel.channel as never,
            maxMissedPings: 2,
            pingFrequencyMsecs: 5
        });

        service.start({
            onHeartbeat: async () => {
            },
            onMissedHeartbeat: async () => {
            }
        });

        expect(channel.messageCallbackCount).toBe(1);

        service.stop();

        expect(channel.removeOnRtcMessageCallbackById).toHaveBeenCalledWith(
            'peer-1-heartbeat'
        );
        expect(channel.messageCallbackCount).toBe(0);
    });
});

function createDataChannelHarness(initiallyOpen = true) {
    let open = initiallyOpen;
    let messageType: string | undefined;
    let onMessageCallback:
        | {
            onMessage: (data: unknown) => Promise<void>;
        }
        | undefined;
    const callbacks = new Map<string, typeof onMessageCallback>();

    const sentJsonStrings: string[] = [];

    const channel = {
        onRtcMessageDo: vi.fn(function (
            _id: string,
            callback: typeof onMessageCallback,
            type: string
        ) {
            onMessageCallback = callback;
            messageType = type;
            callbacks.set(_id, callback);
            return channel;
        }),
        removeOnRtcMessageCallbackById: vi.fn((id: string) => {
            if (callbacks.get(id) === onMessageCallback) {
                onMessageCallback = undefined;
            }
            return callbacks.delete(id);
        }),
        sendAsJsonString: vi.fn(async (data: string) => {
            sentJsonStrings.push(data);
        }),
        isOpen: vi.fn(() => open)
    };

    return {
        channel,
        sentJsonStrings,
        setOpen(value: boolean) {
            open = value;
        },
        get messageType() {
            return messageType;
        },
        get onMessageCallback() {
            return onMessageCallback;
        },
        get removeOnRtcMessageCallbackById() {
            return channel.removeOnRtcMessageCallbackById;
        },
        get messageCallbackCount() {
            return callbacks.size;
        }
    };
}
