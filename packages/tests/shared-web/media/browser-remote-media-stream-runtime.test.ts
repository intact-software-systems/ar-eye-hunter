import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { BrowserRemoteMediaStreamRuntime } from '@shared-web/browser/media/browser-remote-media-stream-runtime.ts';
import type { WebRtcRxStreamerService } from '@shared/services/WebRtcRxStreamerService.ts';
import { describe, expect, it, vi } from 'vitest';

describe('BrowserRemoteMediaStreamRuntime', () => {
    it('owns middleware registration from connection attach through final unsubscribe', async () => {
        let context: ApiMiddleware | undefined;
        let middlewareCallback: (
            peerId: string,
            stream: MediaStream,
            event: RTCTrackEvent
        ) => Promise<void> = async () => undefined;
        let rtcRxStreamer: WebRtcRxStreamerService;
        const onRemoteStreamDo = vi.fn((
            _callbackId: string,
            callback: typeof middlewareCallback
        ) => {
            middlewareCallback = callback;
            return rtcRxStreamer;
        });
        const removeOnRemoteStreamCallbackById = vi.fn();
        rtcRxStreamer = toTestDouble<WebRtcRxStreamerService>({
            onRemoteStreamDo,
            removeOnRemoteStreamCallbackById
        });
        const runtime = new BrowserRemoteMediaStreamRuntime({
            readMiddleware: () => context
        });
        const receivedPeerIds: string[] = [];

        const unsubscribe = runtime.onRemoteStream((remote) => {
            receivedPeerIds.push(remote.peerId);
        });
        expect(onRemoteStreamDo).not.toHaveBeenCalled();

        context = createMiddleware(rtcRxStreamer);
        runtime.attach();
        await middlewareCallback(
            'peer-1',
            toTestDouble<MediaStream>({ id: 'stream-1' }),
            toTestDouble<RTCTrackEvent>({})
        );
        unsubscribe();

        expect(onRemoteStreamDo).toHaveBeenCalledWith(
            'rallar:remote-stream',
            expect.any(Function)
        );
        expect(receivedPeerIds).toEqual(['peer-1']);
        expect(removeOnRemoteStreamCallbackById)
            .toHaveBeenCalledWith('rallar:remote-stream');
    });
});

function createMiddleware(
    rtcRxStreamer: WebRtcRxStreamerService
): ApiMiddleware {
    return toTestDouble<ApiMiddleware>({
        middleware: toTestDouble<ApiMiddleware['middleware']>({
            rtcRxStreamer
        })
    });
}

function toTestDouble<T>(members: Partial<T>): T {
    return members as T;
}
