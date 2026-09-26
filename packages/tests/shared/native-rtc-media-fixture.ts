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

    constructor(track: MediaStreamTrack | null) {
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

export class SimulatedRtcReceiver implements RTCRtpReceiver {
    readonly track: MediaStreamTrack;
    readonly transport = null;
    jitterBufferTarget: number | null = null;
    transform: RTCRtpReceiver['transform'] = null;

    constructor(track: MediaStreamTrack) {
        this.track = track;
    }

    getContributingSources(): RTCRtpContributingSource[] {
        return [];
    }
    getSynchronizationSources(): RTCRtpSynchronizationSource[] {
        return [];
    }
    getParameters(): RTCRtpReceiveParameters {
        return { codecs: [], headerExtensions: [], rtcp: {} };
    }
    async getStats(): Promise<RTCStatsReport> {
        return new Map();
    }
}

export class SimulatedRtcTransceiver implements RTCRtpTransceiver {
    readonly mid = null;
    readonly currentDirection = null;
    readonly receiver: RTCRtpReceiver;
    readonly sender: RTCRtpSender;
    direction: RTCRtpTransceiverDirection = 'sendrecv';
    stopped = false;
    codecs: readonly RTCRtpCodec[] = [];

    constructor(sender: RTCRtpSender, track: MediaStreamTrack) {
        this.sender = sender;
        this.receiver = new SimulatedRtcReceiver(track);
    }

    stop(): void {
        this.stopped = true;
    }
    setCodecPreferences(codecs: RTCRtpCodec[]): void {
        this.codecs = [...codecs];
    }
}

export class SimulatedNativeMediaPeerConnection extends SimulatedNativeRtcPeerConnection {
    private readonly senders: SimulatedRtcSender[] = [];
    private readonly transceivers: SimulatedRtcTransceiver[] = [];

    override addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
        const sender = new SimulatedRtcSender(track);
        sender.setStreams(...streams);
        this.senders.push(sender);
        this.transceivers.push(new SimulatedRtcTransceiver(sender, track));
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
    override getTransceivers(): SimulatedRtcTransceiver[] {
        return [...this.transceivers];
    }
    override addTransceiver(
        trackOrKind?: string | MediaStreamTrack,
        init: RTCRtpTransceiverInit = {}
    ): RTCRtpTransceiver {
        const track = trackOrKind === 'audio' || trackOrKind === 'video'
            ? new SimulatedMediaTrack(trackOrKind)
            : trackOrKind;
        if (!track || typeof track === 'string') {
            throw new Error('Expected an audio/video kind or media track');
        }
        const sender = new SimulatedRtcSender(typeof trackOrKind === 'string' ? null : track);
        const transceiver = new SimulatedRtcTransceiver(sender, track);
        transceiver.direction = init.direction ?? 'sendrecv';
        this.senders.push(sender);
        this.transceivers.push(transceiver);
        return transceiver;
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
