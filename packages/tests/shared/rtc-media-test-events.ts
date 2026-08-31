// Node tests have no native media devices. These complete DOM doubles support
// empty-stream identity and event propagation; using a native device fails explicitly.
export class EmptyMediaStream extends EventTarget implements MediaStream {
    readonly active = true;
    readonly id: string;
    onaddtrack: MediaStream['onaddtrack'] = null;
    onremovetrack: MediaStream['onremovetrack'] = null;

    constructor(id: string) {
        super();
        this.id = id;
    }

    getTracks(): MediaStreamTrack[] {
        return [];
    }
    getAudioTracks(): MediaStreamTrack[] {
        return [];
    }
    getVideoTracks(): MediaStreamTrack[] {
        return [];
    }
    getTrackById(_id: string): null {
        return null;
    }
    clone(): MediaStream {
        return new EmptyMediaStream(this.id);
    }
    addTrack(_track: MediaStreamTrack): void {
        throw new Error('This media fixture has no native tracks');
    }
    removeTrack(_track: MediaStreamTrack): void {
        throw new Error('This media fixture has no native tracks');
    }
}

export class EmptyRtcTrackEvent extends Event implements RTCTrackEvent {
    readonly streams: readonly MediaStream[];

    constructor(stream: MediaStream) {
        super('track');
        this.streams = [stream];
    }

    get receiver(): RTCRtpReceiver {
        throw new Error('This media fixture has no native receiver');
    }
    get track(): MediaStreamTrack {
        throw new Error('This media fixture has no native track');
    }
    get transceiver(): RTCRtpTransceiver {
        throw new Error('This media fixture has no native transceiver');
    }
}
