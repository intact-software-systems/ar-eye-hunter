import {
    P2pRole,
    P2pSignalType,
    type ClientId,
    type P2pSessionId,
    type P2pSignalRecord,
} from '@shared/mod.ts';

import {
    P2pSignalingClient,
    SignalingStateKind,
} from './signalingClient.ts';

/* =========================================================
   Types (no null/undefined exposed)
   ========================================================= */

export enum WebRtcSessionStatus {
    Idle = 'Idle',
    Connecting = 'Connecting',
    Open = 'Open',
    Closed = 'Closed',
    Failed = 'Failed',
}

export type WebRtcSessionConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly signalingPollMs: number;
    readonly dataChannelLabel: string;
};

export const DefaultWebRtcSessionConfig: WebRtcSessionConfig = {
    // STUN-only is enough for many networks. For full reliability you’ll want TURN later.
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    signalingPollMs: 300,
    dataChannelLabel: 'game',
};

export type WebRtcSessionInfo = {
    readonly sessionId: P2pSessionId;
    readonly role: P2pRole;
};

export type WebRtcMessageHandler = (data: string) => void;

export type WebRtcStatusHandler = (status: WebRtcSessionStatus) => void;

export type WebRtcErrorHandler = (message: string) => void;

enum PcKind {
    None = 'None',
    Active = 'Active',
}

type PcRef =
    | { kind: PcKind.None }
    | { kind: PcKind.Active; pc: RTCPeerConnection };

enum DcKind {
    None = 'None',
    Connecting = 'Connecting',
    Open = 'Open',
}

type DcRef =
    | { kind: DcKind.None }
    | { kind: DcKind.Connecting; dc: RTCDataChannel }
    | { kind: DcKind.Open; dc: RTCDataChannel };

type ParsedSdp =
    | { kind: 'Ok'; sdp: RTCSessionDescriptionInit }
    | { kind: 'Invalid' };

type ParsedCandidate =
    | { kind: 'Ok'; cand: RTCIceCandidateInit }
    | { kind: 'Invalid' };

/* =========================================================
   Helpers (minimal validation, no null propagation)
   ========================================================= */

function parseSdp(payload: unknown): ParsedSdp {
    if (typeof payload !== 'object' || payload === null) return { kind: 'Invalid' };
    const p = payload as Record<string, unknown>;
    const type = p['type'];
    const sdp = p['sdp'];

    if (typeof type !== 'string') return { kind: 'Invalid' };
    if (type !== 'offer' && type !== 'answer') return { kind: 'Invalid' };
    if (typeof sdp !== 'string') return { kind: 'Invalid' };

    return { kind: 'Ok', sdp: { type: type as RTCSdpType, sdp } };
}

function parseCandidate(payload: unknown): ParsedCandidate {
    if (typeof payload !== 'object' || payload === null) return { kind: 'Invalid' };
    const p = payload as Record<string, unknown>;

    const candidate = p['candidate'];
    const sdpMid = p['sdpMid'];
    const sdpMLineIndex = p['sdpMLineIndex'];

    // candidate is required, others may be missing depending on browser
    if (typeof candidate !== 'string') return { kind: 'Invalid' };

    const out: RTCIceCandidateInit = { candidate };

    if (typeof sdpMid === 'string') out.sdpMid = sdpMid;
    if (typeof sdpMLineIndex === 'number') out.sdpMLineIndex = sdpMLineIndex;

    return { kind: 'Ok', cand: out };
}

function mustReadySignaling(sig: P2pSignalingClient): { sessionId: P2pSessionId; role: P2pRole } {
    const st = sig.getState();
    if (st.kind !== SignalingStateKind.Ready) {
        throw new Error('Signaling client is not ready. Call createSession/joinSession first.');
    }
    return { sessionId: st.sessionId, role: st.role };
}

/* =========================================================
   Session class
   ========================================================= */

export class WebRtcSession {
    private status: WebRtcSessionStatus = WebRtcSessionStatus.Idle;

    private pcRef: PcRef = { kind: PcKind.None };
    private dcRef: DcRef = { kind: DcKind.None };

    private remoteCandidateQueue: RTCIceCandidateInit[] = [];

    private onMessage: WebRtcMessageHandler = () => {};
    private onStatus: WebRtcStatusHandler = () => {};
    private onError: WebRtcErrorHandler = () => {};

    private readonly config: WebRtcSessionConfig;
    private readonly signaling: P2pSignalingClient;

    private readonly clientId: ClientId;

    public constructor(args: {
        clientId: ClientId;
        signaling: P2pSignalingClient;
        config?: WebRtcSessionConfig;
        onMessage?: WebRtcMessageHandler;
        onStatus?: WebRtcStatusHandler;
        onError?: WebRtcErrorHandler;
    }) {
        this.clientId = args.clientId;
        this.signaling = args.signaling;
        this.config = args.config ? args.config : DefaultWebRtcSessionConfig;

        if (args.onMessage) this.onMessage = args.onMessage;
        if (args.onStatus) this.onStatus = args.onStatus;
        if (args.onError) this.onError = args.onError;
    }

    public getStatus(): WebRtcSessionStatus {
        return this.status;
    }

    public getInfo(): WebRtcSessionInfo {
        const { sessionId, role } = mustReadySignaling(this.signaling);
        return { sessionId, role };
    }

    /** Initiator flow: assumes signaling has already created the session (role=Initiator). */
    public async startInitiator(): Promise<WebRtcSessionInfo> {
        const { sessionId, role } = mustReadySignaling(this.signaling);
        if (role !== P2pRole.Initiator) {
            throw new Error('startInitiator called but signaling role is not Initiator.');
        }

        this.setStatus(WebRtcSessionStatus.Connecting);

        const pc = this.createPeerConnection();
        this.pcRef = { kind: PcKind.Active, pc };

        // Initiator creates the data channel
        const dc = pc.createDataChannel(this.config.dataChannelLabel);
        this.attachDataChannel(dc);

        // Start signaling pump and handle incoming Answer + ICE
        this.signaling.startPump((sig) => void this.handleSignal(sig), this.config.signalingPollMs);

        // Create + send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const local = pc.localDescription;
        if (!local) {
            this.fail('Local description missing after setLocalDescription(offer).');
            return { sessionId, role };
        }

        await this.signaling.postSignal(P2pSignalType.Offer, local);

        return { sessionId, role };
    }

    /** Responder flow: assumes signaling has already joined the session (role=Responder). */
    public async startResponder(): Promise<WebRtcSessionInfo> {
        const { sessionId, role } = mustReadySignaling(this.signaling);
        if (role !== P2pRole.Responder) {
            throw new Error('startResponder called but signaling role is not Responder.');
        }

        this.setStatus(WebRtcSessionStatus.Connecting);

        const pc = this.createPeerConnection();
        this.pcRef = { kind: PcKind.Active, pc };

        // Responder receives data channel via ondatachannel
        pc.ondatachannel = (ev) => {
            this.attachDataChannel(ev.channel);
        };

        // Start signaling pump and wait for Offer + ICE
        this.signaling.startPump((sig) => void this.handleSignal(sig), this.config.signalingPollMs);

        return { sessionId, role };
    }

    public close(): void {
        this.signaling.stopPump();

        if (this.dcRef.kind === DcKind.Open || this.dcRef.kind === DcKind.Connecting) {
            try {
                this.dcRef.dc.close();
            } catch {
                // ignore
            }
        }

        if (this.pcRef.kind === PcKind.Active) {
            try {
                this.pcRef.pc.close();
            } catch {
                // ignore
            }
        }

        this.dcRef = { kind: DcKind.None };
        this.pcRef = { kind: PcKind.None };
        this.remoteCandidateQueue = [];
        this.setStatus(WebRtcSessionStatus.Closed);
    }

    /** Send a string over the data channel. */
    public sendText(text: string): void {
        if (this.dcRef.kind !== DcKind.Open) {
            this.fail('Data channel not open.');
            return;
        }
        try {
            this.dcRef.dc.send(text);
        } catch {
            this.fail('Failed to send on data channel.');
        }
    }

    /** Convenience: send JSON. */
    public sendJson(value: unknown): void {
        this.sendText(JSON.stringify(value));
    }

    /* =========================================================
       Internals
       ========================================================= */

    private setStatus(status: WebRtcSessionStatus): void {
        this.status = status;
        this.onStatus(status);
    }

    private fail(message: string): void {
        this.setStatus(WebRtcSessionStatus.Failed);
        this.onError(message);
    }

    private createPeerConnection(): RTCPeerConnection {
        const pc = new RTCPeerConnection({ iceServers: [...this.config.iceServers] });

        pc.onicecandidate = (ev) => {
            // Trickle ICE: send candidate as it arrives
            if (!ev.candidate) return;
            const init = ev.candidate.toJSON();
            void this.signaling.postSignal(P2pSignalType.IceCandidate, init).catch((e) => {
                this.onError(`Failed to post ICE candidate: ${(e as Error).message}`);
            });
        };

        pc.onconnectionstatechange = () => {
            const s = pc.connectionState;

            if (s === 'connected') {
                // Once connected, signaling is no longer needed for setup.
                // If you want to be extra-safe, you can stop only when dc is open.
                if (this.dcRef.kind === DcKind.Open) {
                    this.signaling.stopPump();
                }
                this.setStatus(WebRtcSessionStatus.Open);
            }

            if (s === 'failed') {
                this.fail('Peer connection failed.');
            }

            if (s === 'closed') {
                this.setStatus(WebRtcSessionStatus.Closed);
            }
        };

        return pc;
    }

    private attachDataChannel(dc: RTCDataChannel): void {
        this.dcRef = { kind: DcKind.Connecting, dc };

        dc.onopen = () => {
            this.dcRef = { kind: DcKind.Open, dc };
            // If PC is already connected, stop signaling now.
            if (this.pcRef.kind === PcKind.Active && this.pcRef.pc.connectionState === 'connected') {
                this.signaling.stopPump();
                this.setStatus(WebRtcSessionStatus.Open);
            }
        };

        dc.onmessage = (ev) => {
            const text = typeof ev.data === 'string' ? ev.data : '';
            this.onMessage(text);
        };

        dc.onclose = () => {
            this.setStatus(WebRtcSessionStatus.Closed);
        };

        dc.onerror = () => {
            this.fail('Data channel error.');
        };
    }

    private async handleSignal(sig: P2pSignalRecord): Promise<void> {
        if (this.pcRef.kind !== PcKind.Active) return;

        const pc = this.pcRef.pc;

        switch (sig.type) {
            case P2pSignalType.Offer: {
                // Responder: receive offer, set remote, create answer, send answer
                const parsed = parseSdp(sig.payload);
                if (parsed.kind === 'Invalid' || parsed.sdp.type !== 'offer') return;

                // If already set, ignore duplicates
                if (pc.remoteDescription && pc.remoteDescription.type === 'offer') return;

                await pc.setRemoteDescription(parsed.sdp);
                await this.flushQueuedCandidates(pc);

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                const local = pc.localDescription;
                if (!local) {
                    this.fail('Local description missing after setLocalDescription(answer).');
                    return;
                }

                await this.signaling.postSignal(P2pSignalType.Answer, local);
                return;
            }

            case P2pSignalType.Answer: {
                // Initiator: receive answer, set remote
                const parsed = parseSdp(sig.payload);
                if (parsed.kind === 'Invalid' || parsed.sdp.type !== 'answer') return;

                // If already set, ignore duplicates
                if (pc.remoteDescription && pc.remoteDescription.type === 'answer') return;

                await pc.setRemoteDescription(parsed.sdp);
                await this.flushQueuedCandidates(pc);
                return;
            }

            case P2pSignalType.IceCandidate: {
                const parsed = parseCandidate(sig.payload);
                if (parsed.kind === 'Invalid') return;

                // If remote description isn't set yet, queue candidates.
                if (!pc.remoteDescription) {
                    this.remoteCandidateQueue.push(parsed.cand);
                    return;
                }

                try {
                    await pc.addIceCandidate(parsed.cand);
                } catch (e) {
                    this.onError(`Failed to add ICE candidate: ${(e as Error).message}`);
                }
                return;
            }
        }
    }

    private async flushQueuedCandidates(pc: RTCPeerConnection): Promise<void> {
        if (!pc.remoteDescription) return;

        const queued = [...this.remoteCandidateQueue];
        this.remoteCandidateQueue = [];

        for (const c of queued) {
            try {
                await pc.addIceCandidate(c);
            } catch (e) {
                this.onError(`Failed to add queued ICE candidate: ${(e as Error).message}`);
            }
        }
    }
}