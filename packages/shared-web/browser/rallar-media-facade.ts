import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';

export type RallarRemoteStream = Readonly<{
    peerId: string;
    stream: MediaStream;
    event: RTCTrackEvent;
}>;

export type RallarMediaSourceKind = 'microphone' | 'camera' | 'screen';

export type RallarMediaSourceState = 'open' | 'ended' | 'failed';

export type RallarMediaSourceStatus = Readonly<{
    kind: RallarMediaSourceKind;
    state: RallarMediaSourceState;
    streamId?: string;
    trackIds: readonly string[];
    audioTrackIds: readonly string[];
    videoTrackIds: readonly string[];
    enabledTrackIds: readonly string[];
    endedTrackIds: readonly string[];
    error?: string;
}>;

export type RallarMediaSourceHandle = Readonly<{
    kind: RallarMediaSourceKind;
    stream: MediaStream;
    status(): RallarMediaSourceStatus;
    attach(): Promise<RallarMediaSourceStatus>;
    setEnabled(enabled: boolean): Promise<RallarMediaSourceStatus>;
    stop(): Promise<RallarMediaSourceStatus>;
}>;

export type RallarMediaSourceAttachOptions = Readonly<{
    attach?: boolean;
}>;

export type RallarMicrophoneSourceStartOptions =
    & RallarMediaSourceAttachOptions
    & Readonly<{
        stream?: MediaStream;
        audio?: boolean | MediaTrackConstraints;
    }>;

export type RallarCameraSourceStartOptions =
    & RallarMediaSourceAttachOptions
    & Readonly<{
        stream?: MediaStream;
        video?: boolean | MediaTrackConstraints;
    }>;

export type RallarScreenSourceStartOptions =
    & RallarMediaSourceAttachOptions
    & Readonly<{
        stream?: MediaStream;
        video?: boolean | MediaTrackConstraints;
        audio?: boolean | MediaTrackConstraints;
    }>;

export type RallarMediaSourceController<TOptions> = Readonly<{
    start(options?: TOptions): Promise<RallarMediaSourceHandle>;
    status(): RallarMediaSourceStatus | undefined;
    stop(): Promise<RallarMediaSourceStatus | undefined>;
}>;

export type RallarMediaSourcesFacade = Readonly<{
    microphone: RallarMediaSourceController<RallarMicrophoneSourceStartOptions>;
    camera: RallarMediaSourceController<RallarCameraSourceStartOptions>;
    screen: RallarMediaSourceController<RallarScreenSourceStartOptions>;
}>;

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
        handler: (remote: RallarRemoteStream) => void | Promise<void>
    ): RallarUnsubscribe;
}>;
