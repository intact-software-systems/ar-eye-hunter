import { QRtcOnRemoteStreamCallback, QRtcOnTrackCallback, QRtcPeerConnection, } from './QRtcPeerConnection.ts';

export enum MediaSessionState {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

export type RtcMediaChannelInputDto = {
    readonly peerId: string;
};

type QRtcMediaChannelStatus = {
    state: MediaSessionState;

    // Convenience flags (source of truth is track.enabled)
    localAudioEnabled: boolean;
    localVideoEnabled: boolean;

    // Convenience cache for UI (mirrors peerConnection.status.remoteStreams)
    remoteStreams: Map<string, MediaStream>;
};

export class QRtcMediaChannel {
    public readonly status: QRtcMediaChannelStatus;

    private readonly onTrackCallbacks = new Map<string, QRtcOnTrackCallback>();
    private readonly onRemoteStreamCallbacks = new Map<string, QRtcOnRemoteStreamCallback>();

    private subscribed: boolean = false;

    constructor(
        public readonly peerConnection: QRtcPeerConnection,
        public readonly input: RtcMediaChannelInputDto,
    ) {
        this.status = this.toInitialStatus();
    }

    private toInitialStatus(): QRtcMediaChannelStatus {
        return {
            state: MediaSessionState.Idle,
            localAudioEnabled: true,
            localVideoEnabled: true,
            remoteStreams: new Map<string, MediaStream>(),
        };
    }

    reset(): void {
        this.unsubscribe();
        this.clearRemoteStreams();

        this.status.state = MediaSessionState.Idle;
    }

    clearRemoteStreams(): void {
        this.status.remoteStreams = new Map<string, MediaStream>();
    }

    clearCallbacks(): void {
        this.onTrackCallbacks.clear();
        this.onRemoteStreamCallbacks.clear();
    }

    // ----------------------------------------
    // Callback registry
    // ----------------------------------------

    onTrackDo(id: string, cb: QRtcOnTrackCallback): QRtcMediaChannel {
        this.onTrackCallbacks.set(id, cb);
        return this;
    }

    removeOnTrackCallbackById(id: string): boolean {
        return this.onTrackCallbacks.delete(id);
    }

    onRemoteStreamDo(id: string, cb: QRtcOnRemoteStreamCallback): QRtcMediaChannel {
        this.onRemoteStreamCallbacks.set(id, cb);
        return this;
    }

    removeOnRemoteStreamCallbackById(id: string): boolean {
        return this.onRemoteStreamCallbacks.delete(id);
    }

    // ----------------------------------------
    // Connect / subscribe
    // ----------------------------------------

    /**
     * Ensures the underlying PeerConnection exists and subscribes to remote track/stream events.
     * Media does not require creating a DataChannel.
     */
    connect() {
        this.status.state = MediaSessionState.Connecting;

        this.subscribe();

        // Mark open when the underlying pc is connected
        if (this.peerConnection.isOpen()) {
            this.status.state = MediaSessionState.Open;
        }
    }

    private subscriptionId(kind: 'track' | 'stream'): string {
        // stable per-peer, used to overwrite rather than accumulate callbacks
        return `${this.input.peerId}:media:${kind}`;
    }

    private subscribe(): void {
        if (this.subscribed) {
            return;
        }

        this.subscribed = true;

        this.peerConnection.onRemoteStreamDo(
            this.subscriptionId('stream'),
            async (stream, event) => {
                // Cache for UI convenience (drawing remote videos, etc.)
                this.status.remoteStreams.set(stream.id, stream);

                for (const cb of this.onRemoteStreamCallbacks.values()) {
                    try {
                        await cb(stream, event);
                    } catch (e) {
                        console.error('QRtcMediaChannel onRemoteStream callback failed', e);
                    }
                }
            },
        );

        this.peerConnection.onTrackDo(
            this.subscriptionId('track'),
            async (event) => {
                for (const cb of this.onTrackCallbacks.values()) {
                    try {
                        await cb(event);
                    } catch (e) {
                        console.error('QRtcMediaChannel onTrack callback failed', e);
                    }
                }
            },
        );
    }

    private unsubscribe(): void {
        if (!this.subscribed) {
            return;
        }

        this.subscribed = false;

        this.peerConnection.removeOnRemoteStreamCallbackById(this.subscriptionId('stream'));
        this.peerConnection.removeOnTrackCallbackById(this.subscriptionId('track'));
    }

    // ----------------------------------------
    // Local media attachment & toggles
    // ----------------------------------------

    async setParameters(
        stream: MediaStream,
        audioEnabled: boolean,
        videoEnabled: boolean,
    ) {
        await this.setLocalMediaStream(stream);
        this.setLocalAudioEnabled(audioEnabled);
        this.setLocalVideoEnabled(videoEnabled);
    }

    /**
     * Attach or replace the local MediaStream on this peer connection.
     * Uses addTrack/replaceTrack inside QRtcPeerConnection.
     */
    async setLocalMediaStream(stream: MediaStream): Promise<void> {
        await this.peerConnection.setLocalMediaStream(stream);

        // Apply current toggle state after attaching
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

    // ----------------------------------------
    // Accessors
    // ----------------------------------------

    getRemoteStreams(): readonly MediaStream[] {
        return [...this.status.remoteStreams.values()];
    }

    isOpen(): boolean {
        return this.status.state === MediaSessionState.Open;
    }

    isReadyToConnect(): boolean {
        return (
            this.status.state === MediaSessionState.Idle ||
            this.status.state === MediaSessionState.Failed ||
            this.status.state === MediaSessionState.Closed
        );
    }
}