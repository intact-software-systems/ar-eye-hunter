import type { RemoteStreamUpdate, RoomAvAdapter } from './roomAvAdapter';
import { WebRtcRxStreamerService } from '@shared/services/WebRtcRxStreamerService.ts';

export class WebRtcRoomAvAdapter implements RoomAvAdapter {
    private joined = false;
    private localStream: MediaStream | undefined = undefined;
    private remoteCb: (u: RemoteStreamUpdate) => void = () => {
    };
    private peerLeftCb: (peerId: string) => void = () => {
    };

    constructor(private readonly rtc: WebRtcRxStreamerService) {
        // forward remote streams from rtc service
        rtc.onRemoteStreamDo('ui-av', async (peerId, stream) => {
                this.remoteCb({ peerId, stream });
            }
        );
    }

    onRemoteStream(cb: (u: RemoteStreamUpdate) => void): void {
        this.remoteCb = cb;
    }

    onPeerLeft(cb: (peerId: string) => void): void {
        this.peerLeftCb = cb;
    }

    isJoined(): boolean {
        return this.joined;
    }

    getLocalStream(): MediaStream | undefined {
        return this.localStream;
    }

    async joinAv(): Promise<void> {
        if (this.joined) return;

        // Must be called from a user gesture (button click) to satisfy browser autoplay policies.
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
        });

        // Keep local ref for preview UI
        this.localStream = stream;

        // Default: muted local preview (avoid echo)
        // Remote audio playback might still require a user gesture in some browsers.

        await this.rtc.setLocalMediaStream(stream);

        // Use current toggle state stored in service (or set defaults)
        this.rtc.setLocalAudioEnabled(true);
        this.rtc.setLocalVideoEnabled(true);

        this.joined = true;
    }

    async leaveAv(): Promise<void> {
        if (!this.joined) return;

        // Stop local tracks
        const s = this.localStream;
        if (s) {
            for (const t of s.getTracks()) {
                try {
                    t.stop();
                } catch { /* ignore */
                }
            }
        }

        // Optional: also tell service to stop local media on all peers
        this.rtc.stopLocalMedia('all');

        this.localStream = undefined;
        this.joined = false;
    }

    setMicEnabled(enabled: boolean): void {
        // toggle local track if present + propagate to peers via service
        this.rtc.setLocalAudioEnabled(enabled);
    }

    setCamEnabled(enabled: boolean): void {
        this.rtc.setLocalVideoEnabled(enabled);
    }
}