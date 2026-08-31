import { SimulatedNativeRtcPeerConnection } from './native-rtc-connection-fixture.ts';
import { EmptyRtcTrackEvent } from './rtc-media-test-events.ts';

export class SimulatedMediaTrack extends EventTarget implements MediaStreamTrack {
    readonly id: string;
    readonly kind: string;
    readonly label = 'simulated-media';
    readonly muted = false;
    contentHint = '';
    enabled = true;
    readyState: MediaStreamTrackState = 'live';
    onended: MediaStreamTrack['onended'] = null;
    onmute: MediaStreamTrack['onmute'] = null;
    onunmute: MediaStreamTrack['onunmute'] = null;
    private constraints: MediaTrackConstraints = {};

    constructor(kind: 'audio' | 'video', id = `${kind}-track`) {
        super();
        this.kind = kind;
        this.id = id;
    }

    async applyConstraints(constraints: MediaTrackConstraints = {}): Promise<void> {
        this.constraints = structuredClone(constraints);
    }
    clone(): MediaStreamTrack {
        throw new Error('Track cloning is outside this native media fixture');
    }
    getCapabilities(): MediaTrackCapabilities {
        return {};
    }
    getConstraints(): MediaTrackConstraints {
        return structuredClone(this.constraints);
    }
    getSettings(): MediaTrackSettings {
        return {};
    }
    stop(): void {
        this.readyState = 'ended';
    }
}

export class SimulatedMediaStream extends EventTarget implements MediaStream {
    readonly id: string;
    onaddtrack: MediaStream['onaddtrack'] = null;
    onremovetrack: MediaStream['onremovetrack'] = null;
    private readonly tracks: MediaStreamTrack[];

    constructor(id: string, tracks: readonly MediaStreamTrack[]) {
        super();
        this.id = id;
        this.tracks = [...tracks];
    }

    get active(): boolean {
        return this.tracks.some((track) => track.readyState === 'live');
    }
    getTracks(): MediaStreamTrack[] {
        return [...this.tracks];
    }
    getAudioTracks(): MediaStreamTrack[] {
        return this.tracks.filter((track) => track.kind === 'audio');
    }
    getVideoTracks(): MediaStreamTrack[] {
        return this.tracks.filter((track) => track.kind === 'video');
    }
    getTrackById(id: string): MediaStreamTrack | null {
        return this.tracks.find((track) => track.id === id) ?? null;
    }
    clone(): MediaStream {
        throw new Error('Stream cloning is outside this native media fixture');
    }
    addTrack(track: MediaStreamTrack): void {
        if (!this.tracks.includes(track)) {
            this.tracks.push(track);
        }
    }
    removeTrack(track: MediaStreamTrack): void {
        const index = this.tracks.indexOf(track);
        if (index >= 0) {
            this.tracks.splice(index, 1);
        }
    }
}

export class SimulatedRtcSender implements RTCRtpSender {
    readonly dtmf = null;
    readonly transport = null;
    transform: RTCRtpSender['transform'] = null;
    streams: readonly MediaStream[] = [];
    private currentTrack: MediaStreamTrack | null;
    private parameters: RTCRtpSendParameters = {
        codecs: [],
        headerExtensions: [],
        rtcp: {},
        encodings: [],
        transactionId: 'simulated-sender'
    };

    constructor(track: MediaStreamTrack) {
        this.currentTrack = track;
    }

    get track(): MediaStreamTrack | null {
        return this.currentTrack;
    }
    getParameters(): RTCRtpSendParameters {
        return structuredClone(this.parameters);
    }
    async getStats(): Promise<RTCStatsReport> {
        return new Map();
    }
    async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
        this.currentTrack = track;
    }
    async setParameters(parameters: RTCRtpSendParameters): Promise<void> {
        this.parameters = structuredClone(parameters);
    }
    setStreams(...streams: MediaStream[]): void {
        this.streams = streams;
    }
}

export class SimulatedNativeMediaPeerConnection extends SimulatedNativeRtcPeerConnection {
    private readonly senders: SimulatedRtcSender[] = [];

    override addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
        const sender = new SimulatedRtcSender(track);
        sender.setStreams(...streams);
        this.senders.push(sender);
        return sender;
    }
    override removeTrack(sender: RTCRtpSender): void {
        if (!this.senders.some((candidate) => candidate === sender)) {
            throw new Error('Cannot remove a sender owned by another native peer');
        }
        void sender.replaceTrack(null);
    }
    override getSenders(): RTCRtpSender[] {
        return [...this.senders];
    }
}

export class SimulatedRtcTrackEvent extends EmptyRtcTrackEvent {
    private readonly eventTrack: MediaStreamTrack;

    constructor(track: MediaStreamTrack, stream: MediaStream) {
        super(stream);
        this.eventTrack = track;
    }

    override get track(): MediaStreamTrack {
        return this.eventTrack;
    }
}
