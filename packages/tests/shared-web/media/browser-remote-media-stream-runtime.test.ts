import { BrowserRemoteMediaStreamRuntime } from '@shared-web/browser/media/browser-remote-media-stream-runtime.ts';
import type { RallarRemoteStream } from '@shared-web/browser/rallar-media-facade.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { EmptyMediaStream, EmptyRtcTrackEvent } from '../../shared/rtc-media-test-events.ts';

describe('BrowserRemoteMediaStreamRuntime', () => {
    it('owns middleware registration from connection attach through final unsubscribe', async () => {
        let context: BrowserRemoteMediaStreamRuntime.Connection | undefined;
        const subscriptions = new RemoteStreamSubscriptions();
        const runtime = new BrowserRemoteMediaStreamRuntime({ readMiddleware: () => context });
        const receivedPeerIds: string[] = [];
        const unsubscribe = runtime.onRemoteStream((remote) => {
            receivedPeerIds.push(remote.peerId);
        });
        expect(subscriptions.callbacks.size).toBe(0);

        context = { middleware: { rtcRxStreamer: subscriptions } };
        runtime.attach();
        expect(subscriptions.callbacks.size).toBe(1);
        const stream = new EmptyMediaStream('stream-1');
        const remote = { peerId: 'peer-1', stream, event: new EmptyRtcTrackEvent(stream) };
        await subscriptions.publish(remote);
        unsubscribe();
        await subscriptions.publish(remote);

        expect(receivedPeerIds).toEqual(['peer-1']);
        expect(subscriptions.callbacks.size).toBe(0);
    });
});

class RemoteStreamSubscriptions implements BrowserRemoteMediaStreamRuntime.StreamSubscriptions {
    readonly callbacks = new Map<string, Parameters<BrowserRemoteMediaStreamRuntime.StreamSubscriptions['onRemoteStreamDo']>[1]>();

    onRemoteStreamDo(
        id: string,
        callback: Parameters<BrowserRemoteMediaStreamRuntime.StreamSubscriptions['onRemoteStreamDo']>[1]
    ): void {
        this.callbacks.set(id, callback);
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.callbacks.delete(id);
    }

    async publish(remote: RallarRemoteStream): Promise<void> {
        for (const callback of this.callbacks.values()) {
            await callback(remote.peerId, remote.stream, remote.event);
        }
    }
}
