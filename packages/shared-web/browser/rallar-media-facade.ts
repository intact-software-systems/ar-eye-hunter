import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';
import type {
    RallarCameraSourceStartOptions,
    RallarMediaSourceController,
    RallarMicrophoneSourceStartOptions,
    RallarRemoteStream,
    RallarScreenSourceStartOptions,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar.ts';

export type RallarMediaFacade = Readonly<{
    microphone: RallarMediaSourceController<RallarMicrophoneSourceStartOptions>;
    camera: RallarMediaSourceController<RallarCameraSourceStartOptions>;
    screen: RallarMediaSourceController<RallarScreenSourceStartOptions>;
    setLocalStream(stream: MediaStream): Promise<void>;
    setAudioEnabled(enabled: boolean): Promise<void>;
    setVideoEnabled(enabled: boolean): Promise<void>;
    stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void>;
    setPolicy(policy: QRtcMediaPolicy): Promise<void>;
    onRemoteStream(
        handler: (remote: RallarRemoteStream) => void | Promise<void>,
    ): RallarUnsubscribe;
}>;

export type CreateRallarMediaFacadeOptions = RallarMediaFacade;

export function createRallarMediaFacade(
    operations: CreateRallarMediaFacadeOptions,
): RallarMediaFacade {
    return {
        microphone: operations.microphone,
        camera: operations.camera,
        screen: operations.screen,
        setLocalStream: async (stream): Promise<void> =>
            await operations.setLocalStream(stream),
        setAudioEnabled: async (enabled): Promise<void> =>
            await operations.setAudioEnabled(enabled),
        setVideoEnabled: async (enabled): Promise<void> =>
            await operations.setVideoEnabled(enabled),
        stopLocal: async (kind): Promise<void> =>
            await operations.stopLocal(kind),
        setPolicy: async (policy): Promise<void> =>
            await operations.setPolicy(policy),
        onRemoteStream: (handler): RallarUnsubscribe =>
            operations.onRemoteStream(handler),
    };
}
