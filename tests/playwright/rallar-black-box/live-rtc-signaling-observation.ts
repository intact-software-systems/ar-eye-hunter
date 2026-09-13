declare global {
    interface Window {
        __liveRtcSignalingObservation?: { read(): LiveRtcSignalingObservation.Snapshot; };
    }
}

export namespace LiveRtcSignalingObservation {
    export interface Received {
        readonly msgId: string | null;
        readonly signalType: 'Offer' | 'Answer' | 'IceCandidate';
        readonly offerId: string | null;
        readonly fromId: string | null;
        readonly toId: string | null;
        readonly receivedAtEpochMs: number;
    }

    export interface NativeState {
        readonly signalingState: string | null;
        readonly connectionState: string | null;
        readonly iceConnectionState: string | null;
    }

    export interface Attempt {
        readonly msgId: string | null;
        readonly signalType: 'Offer' | 'Answer' | null;
        readonly offerId: string | null;
        readonly fromId: string | null;
        readonly toId: string | null;
        readonly receivedAtEpochMs: number | null;
        readonly nativeInstanceOrdinal: number;
        readonly match: 'unique' | 'ambiguous' | 'unmatched';
        readonly attemptedAtEpochMs: number;
        readonly settledAtEpochMs: number | null;
        readonly settlement: 'attempted' | 'applied' | 'rejected';
        readonly state: NativeState;
    }

    export interface Snapshot {
        readonly available: boolean;
        readonly received: readonly Received[];
        readonly attempts: readonly Attempt[];
        readonly droppedReceived: number;
        readonly droppedAttempts: number;
    }

    export interface Join {
        readonly fingerprint: string;
        readonly received: Received;
    }

    export interface Reader {
        readonly readSignalingObservation?: () => Promise<Snapshot | null>;
    }

    export interface Dependencies {
        readonly salt: Uint32Array;
        readonly epochNow: () => number;
    }
}

/** Serialized as one class by Playwright: all runtime dependencies belong to the page. */
export class LiveRtcSignalingObservation {
    readonly #salt: Uint32Array;
    readonly #epochNow: () => number;
    readonly #received: LiveRtcSignalingObservation.Received[] = [];
    readonly #joins: (LiveRtcSignalingObservation.Join | null)[] = [];
    readonly #attempts = new Map<number, LiveRtcSignalingObservation.Attempt>();
    readonly #nativeOrdinals = new WeakMap<RTCPeerConnection, number>();
    #nativeOrdinal = 0;
    #attemptOrdinal = 0;
    #available = true;
    #droppedReceived = 0;
    #droppedAttempts = 0;

    constructor(dependencies: LiveRtcSignalingObservation.Dependencies) {
        this.#salt = dependencies.salt;
        this.#epochNow = dependencies.epochNow;
    }

    static async readFrom(reader: LiveRtcSignalingObservation.Reader): Promise<LiveRtcSignalingObservation.Snapshot> {
        try {
            return LiveRtcSignalingObservation.decodeSnapshot(await reader.readSignalingObservation?.());
        }
        catch {
            return LiveRtcSignalingObservation.decodeSnapshot(null);
        }
    }

    static decodeSnapshot(snapshot: unknown): LiveRtcSignalingObservation.Snapshot {
        const unavailable = { available: false, received: [], attempts: [], droppedReceived: 0, droppedAttempts: 0 };
        if (
            !snapshot || typeof snapshot !== 'object' || !('available' in snapshot) || snapshot.available !== true ||
            !('received' in snapshot) || !Array.isArray(snapshot.received) || !('attempts' in snapshot) ||
            !Array.isArray(snapshot.attempts) ||
            !('droppedReceived' in snapshot) || typeof snapshot.droppedReceived !== 'number' ||
            !Number.isSafeInteger(snapshot.droppedReceived) || snapshot.droppedReceived < 0 ||
            !('droppedAttempts' in snapshot) || typeof snapshot.droppedAttempts !== 'number' ||
            !Number.isSafeInteger(snapshot.droppedAttempts) || snapshot.droppedAttempts < 0
        ) {
            return unavailable;
        }
        const received = Array.from(snapshot.received.slice(-128), LiveRtcSignalingObservation.decodeReceived);
        const attempts = Array.from(snapshot.attempts.slice(-128), LiveRtcSignalingObservation.decodeAttempt);
        if (received.some((entry) => entry === null) || attempts.some((entry) => entry === null)) {
            return unavailable;
        }
        return {
            available: true,
            received: received.filter((entry) => entry !== null),
            attempts: attempts.filter((entry) => entry !== null),
            droppedReceived: Number(snapshot.droppedReceived) + Math.max(0, snapshot.received.length - 128),
            droppedAttempts: Number(snapshot.droppedAttempts) + Math.max(0, snapshot.attempts.length - 128)
        };
    }

    static decodeReceived(received: unknown): LiveRtcSignalingObservation.Received | null {
        if (
            !received || typeof received !== 'object' || !('signalType' in received) ||
            (received.signalType !== 'Offer' && received.signalType !== 'Answer' &&
                received.signalType !== 'IceCandidate') ||
            !('receivedAtEpochMs' in received) || typeof received.receivedAtEpochMs !== 'number' ||
            !Number.isFinite(received.receivedAtEpochMs)
        ) {
            return null;
        }
        return {
            msgId: LiveRtcSignalingObservation.decodeIdentity('msgId' in received ? received.msgId : null),
            signalType: received.signalType,
            offerId: LiveRtcSignalingObservation.decodeIdentity('offerId' in received ? received.offerId : null),
            fromId: LiveRtcSignalingObservation.decodeIdentity('fromId' in received ? received.fromId : null),
            toId: LiveRtcSignalingObservation.decodeIdentity('toId' in received ? received.toId : null),
            receivedAtEpochMs: received.receivedAtEpochMs
        };
    }

    static decodeAttempt(attempt: unknown): LiveRtcSignalingObservation.Attempt | null {
        if (
            !attempt || typeof attempt !== 'object' || !('match' in attempt) ||
            (attempt.match !== 'unique' && attempt.match !== 'ambiguous' && attempt.match !== 'unmatched') ||
            !('settlement' in attempt) || (attempt.settlement !== 'attempted' && attempt.settlement !== 'applied' &&
                attempt.settlement !== 'rejected') ||
            !('nativeInstanceOrdinal' in attempt) || typeof attempt.nativeInstanceOrdinal !== 'number' ||
            !Number.isSafeInteger(attempt.nativeInstanceOrdinal) || attempt.nativeInstanceOrdinal <= 0 ||
            !('attemptedAtEpochMs' in attempt) || typeof attempt.attemptedAtEpochMs !== 'number' ||
            !Number.isFinite(attempt.attemptedAtEpochMs) ||
            !('settledAtEpochMs' in attempt) || (attempt.settledAtEpochMs !== null &&
                (typeof attempt.settledAtEpochMs !== 'number' || !Number.isFinite(attempt.settledAtEpochMs)))
        ) {
            return null;
        }
        return {
            msgId: LiveRtcSignalingObservation.decodeIdentity('msgId' in attempt ? attempt.msgId : null),
            nativeInstanceOrdinal: attempt.nativeInstanceOrdinal,
            signalType: 'signalType' in attempt && (attempt.signalType === 'Offer' || attempt.signalType === 'Answer')
                ? attempt.signalType
                : null,
            offerId: LiveRtcSignalingObservation.decodeIdentity('offerId' in attempt ? attempt.offerId : null),
            fromId: LiveRtcSignalingObservation.decodeIdentity('fromId' in attempt ? attempt.fromId : null),
            toId: LiveRtcSignalingObservation.decodeIdentity('toId' in attempt ? attempt.toId : null),
            receivedAtEpochMs: 'receivedAtEpochMs' in attempt && typeof attempt.receivedAtEpochMs === 'number' &&
                    Number.isFinite(attempt.receivedAtEpochMs)
                ? attempt.receivedAtEpochMs
                : null,
            match: attempt.match,
            attemptedAtEpochMs: attempt.attemptedAtEpochMs,
            settledAtEpochMs: attempt.settledAtEpochMs,
            settlement: attempt.settlement,
            state: LiveRtcSignalingObservation.decodeNativeState('state' in attempt ? attempt.state : null)
        };
    }

    static install(): void {
        const observation = new LiveRtcSignalingObservation({
            salt: crypto.getRandomValues(new Uint32Array(4)),
            epochNow: () => performance.timeOrigin + performance.now()
        });
        window.__liveRtcSignalingObservation = { read: () => observation.read() };
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                this.addEventListener('message', (event) => {
                    if (typeof event.data === 'string') {
                        observation.receive(event.data);
                    }
                });
            }
        };
        const NativePeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeerConnection {
            constructor(configuration?: RTCConfiguration) {
                super(configuration);
                observation.#nativeOrdinals.set(this, ++observation.#nativeOrdinal);
            }

            override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
                const attempt = observation.beginAttempt(this, description);
                try {
                    const completion = super.setRemoteDescription(description);
                    observation.observeSettlement(completion, this, attempt);
                    return completion;
                }
                catch (cause) {
                    observation.settleAttempt(attempt, new WeakRef(this), 'rejected');
                    throw cause;
                }
            }
        };
    }

    read(): LiveRtcSignalingObservation.Snapshot {
        return {
            available: this.#available,
            received: this.#received.map((received) => ({ ...received })),
            attempts: [...this.#attempts.values()].map((attempt) => ({ ...attempt, state: { ...attempt.state } })),
            droppedReceived: this.#droppedReceived,
            droppedAttempts: this.#droppedAttempts
        };
    }

    receive(frame: string): void {
        try {
            const envelope = JSON.parse(frame);
            if (envelope?.payload?.typeId !== 'rtc-signaling' || typeof envelope.payload.resource !== 'string') {
                return;
            }
            const signal = JSON.parse(envelope.payload.resource);
            if (
                signal?.channel !== 'RtcSignal' || signal.type !== 'Signal' ||
                !['Offer', 'Answer', 'IceCandidate'].includes(signal.signalType) ||
                signal.fromId !== envelope.id?.senderId || envelope.targets?.mode !== 'unicast' ||
                signal.toId !== envelope.targets.toPeerId
            ) {
                return;
            }
            const description = LiveRtcSignalingObservation.decodeDescription(signal.payload?.description);
            if (
                signal.signalType !== 'IceCandidate' &&
                (description?.type !== (signal.signalType === 'Offer' ? 'offer' : 'answer') ||
                    LiveRtcSignalingObservation.decodeIdentity(signal.offerId) === null)
            ) {
                return;
            }
            const received: LiveRtcSignalingObservation.Received = {
                msgId: LiveRtcSignalingObservation.decodeIdentity(envelope.id?.msgId),
                signalType: signal.signalType,
                offerId: signal.signalType === 'IceCandidate'
                    ? null
                    : LiveRtcSignalingObservation.decodeIdentity(signal.offerId),
                fromId: LiveRtcSignalingObservation.decodeIdentity(signal.fromId),
                toId: LiveRtcSignalingObservation.decodeIdentity(signal.toId),
                receivedAtEpochMs: this.#epochNow()
            };
            const fingerprint = signal.signalType === 'IceCandidate'
                ? null
                : this.computeFingerprint(description);
            this.#received.push(received);
            this.#joins.push(fingerprint === null ? null : { fingerprint, received });
            if (this.#received.length > 128) {
                this.#received.shift();
                this.#joins.shift();
                this.#droppedReceived++;
            }
        }
        catch (cause) {
            if (!(cause instanceof SyntaxError)) {
                this.#available = false;
            }
        }
    }

    beginAttempt(peer: RTCPeerConnection, description: RTCSessionDescriptionInit): number | null {
        try {
            const fingerprint = this.computeFingerprint(description);
            if (fingerprint === null) {
                return null;
            }
            const matches = this.#joins.filter((join) => join !== null && join.fingerprint === fingerprint);
            const messageIds = new Set(matches.map((join) => join?.received.msgId));
            const match = matches.length === 0
                ? 'unmatched'
                : messageIds.size === 1 && !messageIds.has(null)
                ? 'unique'
                : 'ambiguous';
            const received = match === 'unique' ? matches[0]?.received : undefined;
            const attempt: LiveRtcSignalingObservation.Attempt = {
                msgId: received?.msgId ?? null,
                signalType: received?.signalType === 'Offer' || received?.signalType === 'Answer'
                    ? received.signalType
                    : null,
                offerId: received?.offerId ?? null,
                fromId: received?.fromId ?? null,
                toId: received?.toId ?? null,
                receivedAtEpochMs: received?.receivedAtEpochMs ?? null,
                nativeInstanceOrdinal: this.#nativeOrdinals.get(peer) ?? 0,
                match,
                attemptedAtEpochMs: this.#epochNow(),
                settledAtEpochMs: null,
                settlement: 'attempted',
                state: LiveRtcSignalingObservation.decodeNativeState(peer)
            };
            const ordinal = ++this.#attemptOrdinal;
            this.#attempts.set(ordinal, attempt);
            if (this.#attempts.size > 128) {
                this.#attempts.delete(ordinal - 128);
                this.#droppedAttempts++;
            }
            return ordinal;
        }
        catch {
            this.#available = false;
            return null;
        }
    }

    observeSettlement(
        completion: Promise<void>,
        peer: RTCPeerConnection,
        attemptOrdinal: number | null
    ): void {
        try {
            const reference = new WeakRef(peer);
            void completion.then(
                () => this.settleAttempt(attemptOrdinal, reference, 'applied'),
                () => this.settleAttempt(attemptOrdinal, reference, 'rejected')
            );
        }
        catch {
            this.#available = false;
        }
    }

    settleAttempt(
        attemptOrdinal: number | null,
        reference: WeakRef<RTCPeerConnection>,
        settlement: 'applied' | 'rejected'
    ): void {
        try {
            const attempt = attemptOrdinal === null ? undefined : this.#attempts.get(attemptOrdinal);
            if (!attempt || attemptOrdinal === null) {
                return;
            }
            this.#attempts.set(attemptOrdinal, {
                ...attempt,
                settlement,
                settledAtEpochMs: this.#epochNow(),
                state: LiveRtcSignalingObservation.decodeNativeState(reference.deref())
            });
        }
        catch {
            this.#available = false;
        }
    }

    static decodeNativeState(peer: unknown): LiveRtcSignalingObservation.NativeState {
        if (!peer || typeof peer !== 'object') {
            return { signalingState: null, connectionState: null, iceConnectionState: null };
        }
        return {
            signalingState: LiveRtcSignalingObservation.decodeAllowedState(
                'signalingState' in peer ? peer.signalingState : null,
                [
                    'stable',
                    'have-local-offer',
                    'have-remote-offer',
                    'have-local-pranswer',
                    'have-remote-pranswer',
                    'closed'
                ]
            ),
            connectionState: LiveRtcSignalingObservation.decodeAllowedState(
                'connectionState' in peer ? peer.connectionState : null,
                [
                    'new',
                    'connecting',
                    'connected',
                    'disconnected',
                    'failed',
                    'closed'
                ]
            ),
            iceConnectionState: LiveRtcSignalingObservation.decodeAllowedState(
                'iceConnectionState' in peer ? peer.iceConnectionState : null,
                [
                    'new',
                    'checking',
                    'connected',
                    'completed',
                    'disconnected',
                    'failed',
                    'closed'
                ]
            )
        };
    }

    static decodeIdentity(value: unknown): string | null {
        return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
    }

    static decodeAllowedState(value: unknown, allowed: readonly string[]): string | null {
        return typeof value === 'string' && allowed.includes(value) ? value : null;
    }

    static decodeDescription(description: unknown): RTCSessionDescriptionInit | null {
        if (
            !description || typeof description !== 'object' || !('type' in description) ||
            (description.type !== 'offer' && description.type !== 'answer') ||
            !('sdp' in description) || typeof description.sdp !== 'string'
        ) {
            return null;
        }
        return { type: description.type, sdp: description.sdp };
    }

    computeFingerprint(description: RTCSessionDescriptionInit | null): string | null {
        if (
            description === null || (description.type !== 'offer' && description.type !== 'answer') ||
            typeof description.sdp !== 'string'
        ) {
            return null;
        }
        const text = `${description.type}:${description.sdp}`;
        const hash = this.#salt.slice();
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            for (let lane = 0; lane < hash.length; lane++) {
                hash[lane] = Math.imul(hash[lane] ^ code, 16777619 + lane * 2) >>> 0;
            }
        }
        return [...hash].map((value) => value.toString(16).padStart(8, '0')).join('');
    }
}
