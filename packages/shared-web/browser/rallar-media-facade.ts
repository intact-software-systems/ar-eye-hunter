import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { QRtcMediaPolicy } from '@shared/webrtc/QRtcPeerConnection.ts';

export interface RallarRemoteStream {
    readonly peerId: string;
    readonly stream: MediaStream;
    readonly event: RTCTrackEvent;
}

export type RallarMediaSourceKind = 'microphone' | 'camera' | 'screen';

export type RallarMediaSourceState = 'open' | 'ended' | 'failed';

export interface RallarMediaSourceStatus {
    readonly kind: RallarMediaSourceKind;
    readonly state: RallarMediaSourceState;
    readonly streamId?: string;
    readonly trackIds: readonly string[];
    readonly audioTrackIds: readonly string[];
    readonly videoTrackIds: readonly string[];
    readonly enabledTrackIds: readonly string[];
    readonly endedTrackIds: readonly string[];
    readonly error?: string;
}

export interface RallarMediaSourceHandle {
    readonly kind: RallarMediaSourceKind;
    readonly stream: MediaStream;
    status(): RallarMediaSourceStatus;
    attach(): Promise<RallarMediaSourceStatus>;
    setEnabled(enabled: boolean): Promise<RallarMediaSourceStatus>;
    stop(): Promise<RallarMediaSourceStatus>;
}

export interface RallarMediaSourceAttachOptions {
    readonly attach?: boolean;
}

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

export interface RallarMediaSourceController<TOptions> {
    start(options?: TOptions): Promise<RallarMediaSourceHandle>;
    status(): RallarMediaSourceStatus | undefined;
    stop(): Promise<RallarMediaSourceStatus | undefined>;
}

export interface RallarMediaSourcesFacade {
    readonly microphone: RallarMediaSourceController<RallarMicrophoneSourceStartOptions>;
    readonly camera: RallarMediaSourceController<RallarCameraSourceStartOptions>;
    readonly screen: RallarMediaSourceController<RallarScreenSourceStartOptions>;
}

export interface RallarMediaFacade {
    readonly microphone: RallarMediaSourceController<RallarMicrophoneSourceStartOptions>;
    readonly camera: RallarMediaSourceController<RallarCameraSourceStartOptions>;
    readonly screen: RallarMediaSourceController<RallarScreenSourceStartOptions>;
    setLocalStream(stream: MediaStream): Promise<void>;
    setAudioEnabled(enabled: boolean): Promise<void>;
    setVideoEnabled(enabled: boolean): Promise<void>;
    stopLocal(kind: 'audio' | 'video' | 'all'): Promise<void>;
    setPolicy(policy: QRtcMediaPolicy): Promise<void>;
    onRemoteStream(handler: (remote: RallarRemoteStream) => void | Promise<void>): RallarUnsubscribe;
}
