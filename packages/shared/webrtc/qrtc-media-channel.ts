import { toError } from '../resilience/to-error.ts';

import { QRtcOnRemoteStreamCallback, QRtcOnTrackCallback, QRtcPeerConnection } from './qrtc-peer-connection.ts';

export const MediaSessionState = {
    Idle: 'Idle',
    Connecting: 'Connecting',
    Open: 'Open'
} as const;

export type MediaSessionState = (typeof MediaSessionState)[keyof typeof MediaSessionState];

export namespace QRtcMediaChannel {
    export interface InputDto {
        readonly peerId: string;
    }

    export interface Status {
        state: MediaSessionState;
        localAudioEnabled: boolean;
        localVideoEnabled: boolean;
        remoteStreams: Map<string, MediaStream>;
    }
}

export class QRtcMediaChannel {
    public readonly status: QRtcMediaChannel.Status;

    private readonly onTrackCallbacks = new Map<string, QRtcOnTrackCallback>();
    private readonly onRemoteStreamCallbacks = new Map<string, QRtcOnRemoteStreamCallback>();

    private subscribed: boolean = false;

    public readonly peerConnection: QRtcPeerConnection;
    public readonly input: QRtcMediaChannel.InputDto;

    constructor(
        peerConnection: QRtcPeerConnection,
        input: QRtcMediaChannel.InputDto
    ) {
        this.peerConnection = peerConnection;
        this.input = input;
        this.status = {
            state: MediaSessionState.Idle,
            localAudioEnabled: true,
            localVideoEnabled: true,
            remoteStreams: new Map<string, MediaStream>()
        };
    }

    reset(): void {
        this.unsubscribe();
        this.status.remoteStreams.clear();

        this.status.state = MediaSessionState.Idle;
    }

    clearCallbacks(): void {
        this.onTrackCallbacks.clear();
        this.onRemoteStreamCallbacks.clear();
    }

    onTrackDo(id: string, callback: QRtcOnTrackCallback): QRtcMediaChannel {
        this.onTrackCallbacks.set(id, callback);
        return this;
    }

    removeOnTrackCallbackById(id: string): boolean {
        return this.onTrackCallbacks.delete(id);
    }

    onRemoteStreamDo(id: string, callback: QRtcOnRemoteStreamCallback): QRtcMediaChannel {
        this.onRemoteStreamCallbacks.set(id, callback);
        return this;
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

    connect(): void {
        this.status.state = MediaSessionState.Connecting;

        this.subscribe();

        if (this.peerConnection.isOpen()) {
            this.status.state = MediaSessionState.Open;
        }
    }

    private subscriptionId(kind: 'track' | 'stream'): string {
        return `${this.input.peerId}:media:${kind}`;
    }

    private subscribe(): void {
        if (this.subscribed) {
            return;
        }
        this.subscribed = true;
        this.peerConnection.onRemoteStreamDo(
            this.subscriptionId('stream'),
            (stream, event) => this.publishRemoteStream(stream, event)
        );
        this.peerConnection.onTrackDo(
            this.subscriptionId('track'),
            (event) => this.publishRemoteTrack(event)
        );
    }

    private async publishRemoteStream(stream: MediaStream, event: RTCTrackEvent): Promise<void> {
        this.status.remoteStreams.set(stream.id, stream);
        for (const callback of this.onRemoteStreamCallbacks.values()) {
            try {
                await callback(stream, event);
            }
            catch (error) {
                console.error('QRtcMediaChannel onRemoteStream callback failed', toError(error));
            }
        }
    }

    private async publishRemoteTrack(event: RTCTrackEvent): Promise<void> {
        for (const callback of this.onTrackCallbacks.values()) {
            try {
                await callback(event);
            }
            catch (error) {
                console.error('QRtcMediaChannel onTrack callback failed', toError(error));
            }
        }
    }

    private unsubscribe(): void {
        if (!this.subscribed) {
            return;
        }

        this.subscribed = false;

        this.peerConnection.removeOnRemoteStreamCallbackById(this.subscriptionId('stream'));
        this.peerConnection.removeOnTrackCallbackById(this.subscriptionId('track'));
    }

    async setParameters(
        stream: MediaStream,
        audioEnabled: boolean,
        videoEnabled: boolean
    ): Promise<void> {
        await this.setLocalMediaStream(stream);
        this.setLocalAudioEnabled(audioEnabled);
        this.setLocalVideoEnabled(videoEnabled);
    }

    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        await this.peerConnection.setLocalMediaStream(stream);

        this.peerConnection.setLocalAudioEnabled(this.status.localAudioEnabled);
        this.peerConnection.setLocalVideoEnabled(this.status.localVideoEnabled);
    }

    setLocalAudioEnabled(enabled: boolean): void {
        this.status.localAudioEnabled = enabled;
        this.peerConnection.setLocalAudioEnabled(enabled);
    }

    setLocalVideoEnabled(enabled: boolean): void {
        this.status.localVideoEnabled = enabled;
        this.peerConnection.setLocalVideoEnabled(enabled);
    }

    stopLocalMedia(kind: 'audio' | 'video' | 'all'): void {
        this.peerConnection.stopLocalMedia(kind);
    }

    getRemoteStreams(): readonly MediaStream[] {
        return [...this.status.remoteStreams.values()];
    }

    isOpen(): boolean {
        return this.status.state === MediaSessionState.Open;
    }

    isReadyToConnect(): boolean {
        return this.status.state === MediaSessionState.Idle;
    }
}
