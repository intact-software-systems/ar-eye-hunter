import { createRallarMediaFacade } from '@shared-web/browser/rallar-media-facade.ts';
import type {
    RallarCameraSourceStartOptions,
    RallarMediaSourceController,
    RallarMicrophoneSourceStartOptions,
    RallarRemoteStream,
    RallarScreenSourceStartOptions
} from '@shared-web/browser/rallar.ts';
import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar media facade factory', () => {
    it('delegates media methods through injected operations', async () => {
        const microphone = createController<RallarMicrophoneSourceStartOptions>();
        const camera = createController<RallarCameraSourceStartOptions>();
        const screen = createController<RallarScreenSourceStartOptions>();
        const stream = { id: 'stream-1' } as MediaStream;
        const policy = {} as QRtcMediaPolicy;
        const unsubscribe = vi.fn();
        const remoteStreamHandler = vi.fn(
            (_remote: RallarRemoteStream): void => {}
        );
        const operations = {
            microphone,
            camera,
            screen,
            setLocalStream: vi.fn(async () => {}),
            setAudioEnabled: vi.fn(async () => {}),
            setVideoEnabled: vi.fn(async () => {}),
            stopLocal: vi.fn(async () => {}),
            setPolicy: vi.fn(async () => {}),
            onRemoteStream: vi.fn(() => unsubscribe)
        };

        const facade = createRallarMediaFacade(operations);

        expect(facade.microphone).toBe(microphone);
        expect(facade.camera).toBe(camera);
        expect(facade.screen).toBe(screen);
        await facade.setLocalStream(stream);
        await facade.setAudioEnabled(false);
        await facade.setVideoEnabled(true);
        await facade.stopLocal('all');
        await facade.setPolicy(policy);
        expect(facade.onRemoteStream(remoteStreamHandler)).toBe(unsubscribe);

        expect(operations.setLocalStream).toHaveBeenCalledWith(stream);
        expect(operations.setAudioEnabled).toHaveBeenCalledWith(false);
        expect(operations.setVideoEnabled).toHaveBeenCalledWith(true);
        expect(operations.stopLocal).toHaveBeenCalledWith('all');
        expect(operations.setPolicy).toHaveBeenCalledWith(policy);
        expect(operations.onRemoteStream).toHaveBeenCalledWith(
            remoteStreamHandler
        );
    });
});

function createController<TOptions>(): RallarMediaSourceController<TOptions> {
    return {
        start: vi.fn(),
        status: vi.fn(),
        stop: vi.fn()
    };
}
