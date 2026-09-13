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
        readonly nativeLifetimes: readonly NativeLifetime[];
        readonly droppedNativeLifetimes: number;
    }

    export interface NativeLifetime {
        readonly nativeInstanceOrdinal: number;
        readonly createdAtEpochMs: number;
        readonly creationState: NativeState;
        readonly closedAtEpochMs: number | null;
        readonly closeState: NativeState | null;
        readonly observedAtEpochMs: number | null;
        readonly observation: 'live' | 'collected' | 'unavailable';
        readonly state: NativeState;
    }

    export interface Reader {
        readonly readSignalingObservation?: () => Promise<Snapshot | null>;
    }
}

/** Serialized by Playwright before app startup; contains no imported runtime dependencies. */
export function installLiveRtcSignalingObservation(): void {
    interface Join {
        readonly fingerprint: string;
        readonly received: LiveRtcSignalingObservation.Received;
    }

    interface TrackedNative {
        readonly reference: WeakRef<RTCPeerConnection>;
        lifetime: LiveRtcSignalingObservation.NativeLifetime;
    }

    const salt = crypto.getRandomValues(new Uint32Array(4));
    const epochNow = () => performance.timeOrigin + performance.now();
    const received: LiveRtcSignalingObservation.Received[] = [];
    const joins: (Join | null)[] = [];
    const attempts = new Map<number, LiveRtcSignalingObservation.Attempt>();
    const nativeOrdinals = new WeakMap<RTCPeerConnection, number>();
    const nativeLifetimes = new Map<number, TrackedNative>();
    let nativeOrdinal = 0;
    let attemptOrdinal = 0;
    let available = true;
    let droppedReceived = 0;
    let droppedAttempts = 0;
    let droppedNativeLifetimes = 0;

    function decodeAllowedState(value: unknown, allowed: readonly string[]): string | null {
        return typeof value === 'string' && allowed.includes(value) ? value : null;
    }

    function decodeIdentity(value: unknown): string | null {
        return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
    }

    function decodeNativeState(peer: unknown): LiveRtcSignalingObservation.NativeState {
        if (!peer || typeof peer !== 'object') {
            return { signalingState: null, connectionState: null, iceConnectionState: null };
        }
        return {
            signalingState: decodeAllowedState(
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
            connectionState: decodeAllowedState(
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
            iceConnectionState: decodeAllowedState(
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

    function decodeDescription(description: unknown): RTCSessionDescriptionInit | null {
        if (
            !description || typeof description !== 'object' || !('type' in description) ||
            (description.type !== 'offer' && description.type !== 'answer') ||
            !('sdp' in description) || typeof description.sdp !== 'string'
        ) {
            return null;
        }
        return { type: description.type, sdp: description.sdp };
    }

    function computeFingerprint(description: RTCSessionDescriptionInit | null): string | null {
        if (
            description === null || (description.type !== 'offer' && description.type !== 'answer') ||
            typeof description.sdp !== 'string'
        ) {
            return null;
        }
        const text = `${description.type}:${description.sdp}`;
        const hash = salt.slice();
        for (let index = 0; index < text.length; index++) {
            const code = text.charCodeAt(index);
            for (let lane = 0; lane < hash.length; lane++) {
                hash[lane] = Math.imul(hash[lane] ^ code, 16777619 + lane * 2) >>> 0;
            }
        }
        return [...hash].map((value) => value.toString(16).padStart(8, '0')).join('');
    }

    function readNativeLifetime(tracked: TrackedNative): LiveRtcSignalingObservation.NativeLifetime {
        const lifetime = {
            ...tracked.lifetime,
            creationState: { ...tracked.lifetime.creationState },
            closeState: tracked.lifetime.closeState === null ? null : { ...tracked.lifetime.closeState }
        };
        try {
            const peer = tracked.reference.deref();
            return {
                ...lifetime,
                observedAtEpochMs: epochNow(),
                observation: peer ? 'live' : 'collected',
                state: decodeNativeState(peer)
            };
        }
        catch {
            return {
                ...lifetime,
                observedAtEpochMs: null,
                observation: 'unavailable',
                state: decodeNativeState(null)
            };
        }
    }

    function read(): LiveRtcSignalingObservation.Snapshot {
        return {
            available,
            received: received.map((entry) => ({ ...entry })),
            attempts: [...attempts.values()].map((attempt) => ({ ...attempt, state: { ...attempt.state } })),
            droppedReceived,
            droppedAttempts,
            nativeLifetimes: [...nativeLifetimes.values()].map(readNativeLifetime),
            droppedNativeLifetimes
        };
    }

    function recordNativeCreation(peer: RTCPeerConnection): void {
        const ordinal = ++nativeOrdinal;
        nativeOrdinals.set(peer, ordinal);
        try {
            const createdAtEpochMs = epochNow();
            const creationState = decodeNativeState(peer);
            nativeLifetimes.set(ordinal, {
                reference: new WeakRef(peer),
                lifetime: {
                    nativeInstanceOrdinal: ordinal,
                    createdAtEpochMs,
                    creationState,
                    closedAtEpochMs: null,
                    closeState: null,
                    observedAtEpochMs: createdAtEpochMs,
                    observation: 'live',
                    state: creationState
                }
            });
            if (nativeLifetimes.size > 128) {
                const oldest = nativeLifetimes.keys().next().value;
                if (oldest !== undefined) {
                    nativeLifetimes.delete(oldest);
                    droppedNativeLifetimes++;
                }
            }
        }
        catch {
            available = false;
        }
    }

    function recordNativeClose(peer: RTCPeerConnection): void {
        try {
            const tracked = nativeLifetimes.get(nativeOrdinals.get(peer) ?? 0);
            if (tracked && tracked.lifetime.closedAtEpochMs === null) {
                tracked.lifetime = {
                    ...tracked.lifetime,
                    closedAtEpochMs: epochNow(),
                    closeState: decodeNativeState(peer)
                };
            }
        }
        catch {
            available = false;
        }
    }

    function receive(frame: string): void {
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
            const description = decodeDescription(signal.payload?.description);
            if (
                signal.signalType !== 'IceCandidate' &&
                (description?.type !== (signal.signalType === 'Offer' ? 'offer' : 'answer') ||
                    decodeIdentity(signal.offerId) === null)
            ) {
                return;
            }
            const entry: LiveRtcSignalingObservation.Received = {
                msgId: decodeIdentity(envelope.id?.msgId),
                signalType: signal.signalType,
                offerId: signal.signalType === 'IceCandidate' ? null : decodeIdentity(signal.offerId),
                fromId: decodeIdentity(signal.fromId),
                toId: decodeIdentity(signal.toId),
                receivedAtEpochMs: epochNow()
            };
            const fingerprint = signal.signalType === 'IceCandidate' ? null : computeFingerprint(description);
            received.push(entry);
            joins.push(fingerprint === null ? null : { fingerprint, received: entry });
            if (received.length > 128) {
                received.shift();
                joins.shift();
                droppedReceived++;
            }
        }
        catch (cause) {
            if (!(cause instanceof SyntaxError)) {
                available = false;
            }
        }
    }

    function beginAttempt(peer: RTCPeerConnection, description: RTCSessionDescriptionInit): number | null {
        try {
            const fingerprint = computeFingerprint(description);
            if (fingerprint === null) {
                return null;
            }
            const matches = joins.filter((join) => join !== null && join.fingerprint === fingerprint);
            const messageIds = new Set(matches.map((join) => join?.received.msgId));
            const match = matches.length === 0
                ? 'unmatched'
                : messageIds.size === 1 && !messageIds.has(null)
                ? 'unique'
                : 'ambiguous';
            const matchedReceived = match === 'unique' ? matches[0]?.received : undefined;
            const attempt: LiveRtcSignalingObservation.Attempt = {
                msgId: matchedReceived?.msgId ?? null,
                signalType: matchedReceived?.signalType === 'Offer' || matchedReceived?.signalType === 'Answer'
                    ? matchedReceived.signalType
                    : null,
                offerId: matchedReceived?.offerId ?? null,
                fromId: matchedReceived?.fromId ?? null,
                toId: matchedReceived?.toId ?? null,
                receivedAtEpochMs: matchedReceived?.receivedAtEpochMs ?? null,
                nativeInstanceOrdinal: nativeOrdinals.get(peer) ?? 0,
                match,
                attemptedAtEpochMs: epochNow(),
                settledAtEpochMs: null,
                settlement: 'attempted',
                state: decodeNativeState(peer)
            };
            const ordinal = ++attemptOrdinal;
            attempts.set(ordinal, attempt);
            if (attempts.size > 128) {
                attempts.delete(ordinal - 128);
                droppedAttempts++;
            }
            return ordinal;
        }
        catch {
            available = false;
            return null;
        }
    }

    function settleAttempt(
        ordinal: number | null,
        reference: WeakRef<RTCPeerConnection>,
        settlement: 'applied' | 'rejected'
    ): void {
        try {
            const attempt = ordinal === null ? undefined : attempts.get(ordinal);
            if (!attempt || ordinal === null) {
                return;
            }
            attempts.set(ordinal, {
                ...attempt,
                settlement,
                settledAtEpochMs: epochNow(),
                state: decodeNativeState(reference.deref())
            });
        }
        catch {
            available = false;
        }
    }

    function observeSettlement(
        completion: Promise<void>,
        peer: RTCPeerConnection,
        ordinal: number | null
    ): void {
        try {
            const reference = new WeakRef(peer);
            void completion.then(
                () => settleAttempt(ordinal, reference, 'applied'),
                () => settleAttempt(ordinal, reference, 'rejected')
            );
        }
        catch {
            available = false;
        }
    }

    window.__liveRtcSignalingObservation = { read };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('message', (event) => {
                if (typeof event.data === 'string') {
                    receive(event.data);
                }
            });
        }
    };
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
        constructor(configuration?: RTCConfiguration) {
            super(configuration);
            recordNativeCreation(this);
        }

        override close(): void {
            const result = super.close();
            recordNativeClose(this);
            return result;
        }

        override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
            const ordinal = beginAttempt(this, description);
            try {
                const completion = super.setRemoteDescription(description);
                observeSettlement(completion, this, ordinal);
                return completion;
            }
            catch (cause) {
                settleAttempt(ordinal, new WeakRef(this), 'rejected');
                throw cause;
            }
        }
    };
}

export async function readLiveRtcSignalingObservation(
    reader: LiveRtcSignalingObservation.Reader
): Promise<LiveRtcSignalingObservation.Snapshot> {
    try {
        return decodeLiveRtcSignalingObservationSnapshot(await reader.readSignalingObservation?.());
    }
    catch {
        return decodeLiveRtcSignalingObservationSnapshot(null);
    }
}

export function decodeLiveRtcSignalingObservationSnapshot(
    snapshot: unknown
): LiveRtcSignalingObservation.Snapshot {
    const unavailable = createUnavailableLiveRtcSignalingObservationSnapshot();
    if (
        !snapshot || typeof snapshot !== 'object' || !('available' in snapshot) || snapshot.available !== true ||
        !('received' in snapshot) || !Array.isArray(snapshot.received) || !('attempts' in snapshot) ||
        !Array.isArray(snapshot.attempts) ||
        !('droppedReceived' in snapshot) || typeof snapshot.droppedReceived !== 'number' ||
        !Number.isSafeInteger(snapshot.droppedReceived) || snapshot.droppedReceived < 0 ||
        !('droppedAttempts' in snapshot) || typeof snapshot.droppedAttempts !== 'number' ||
        !Number.isSafeInteger(snapshot.droppedAttempts) || snapshot.droppedAttempts < 0 ||
        !('nativeLifetimes' in snapshot) || !Array.isArray(snapshot.nativeLifetimes) ||
        !('droppedNativeLifetimes' in snapshot) || typeof snapshot.droppedNativeLifetimes !== 'number' ||
        !Number.isSafeInteger(snapshot.droppedNativeLifetimes) || snapshot.droppedNativeLifetimes < 0
    ) {
        return unavailable;
    }
    const received = Array.from(snapshot.received.slice(-128), decodeLiveRtcSignalingReceived);
    const attempts = Array.from(snapshot.attempts.slice(-128), decodeLiveRtcSignalingAttempt);
    const nativeLifetimes = Array.from(snapshot.nativeLifetimes.slice(-128), decodeLiveRtcNativeLifetime);
    if (
        received.some((entry) => entry === null) || attempts.some((entry) => entry === null) ||
        nativeLifetimes.some((entry) => entry === null)
    ) {
        return unavailable;
    }
    return {
        available: true,
        received: received.filter((entry) => entry !== null),
        attempts: attempts.filter((entry) => entry !== null),
        droppedReceived: Number(snapshot.droppedReceived) + Math.max(0, snapshot.received.length - 128),
        droppedAttempts: Number(snapshot.droppedAttempts) + Math.max(0, snapshot.attempts.length - 128),
        nativeLifetimes: nativeLifetimes.filter((entry) => entry !== null),
        droppedNativeLifetimes: snapshot.droppedNativeLifetimes + Math.max(0, snapshot.nativeLifetimes.length - 128)
    };
}

function createUnavailableLiveRtcSignalingObservationSnapshot(): LiveRtcSignalingObservation.Snapshot {
    return {
        available: false,
        received: [],
        attempts: [],
        nativeLifetimes: [],
        droppedReceived: 0,
        droppedAttempts: 0,
        droppedNativeLifetimes: 0
    };
}

function decodeLiveRtcNativeLifetime(lifetime: unknown): LiveRtcSignalingObservation.NativeLifetime | null {
    if (
        !lifetime || typeof lifetime !== 'object' ||
        !('nativeInstanceOrdinal' in lifetime) || typeof lifetime.nativeInstanceOrdinal !== 'number' ||
        !Number.isSafeInteger(lifetime.nativeInstanceOrdinal) || lifetime.nativeInstanceOrdinal <= 0 ||
        !('createdAtEpochMs' in lifetime) || typeof lifetime.createdAtEpochMs !== 'number' ||
        !Number.isFinite(lifetime.createdAtEpochMs) ||
        !('closedAtEpochMs' in lifetime) || (lifetime.closedAtEpochMs !== null &&
            (typeof lifetime.closedAtEpochMs !== 'number' || !Number.isFinite(lifetime.closedAtEpochMs))) ||
        !('observedAtEpochMs' in lifetime) || (lifetime.observedAtEpochMs !== null &&
            (typeof lifetime.observedAtEpochMs !== 'number' || !Number.isFinite(lifetime.observedAtEpochMs))) ||
        !('observation' in lifetime) ||
        (lifetime.observation !== 'live' && lifetime.observation !== 'collected' &&
            lifetime.observation !== 'unavailable')
    ) {
        return null;
    }
    return {
        nativeInstanceOrdinal: lifetime.nativeInstanceOrdinal,
        createdAtEpochMs: lifetime.createdAtEpochMs,
        creationState: decodeLiveRtcNativeState('creationState' in lifetime ? lifetime.creationState : null),
        closedAtEpochMs: lifetime.closedAtEpochMs,
        closeState: lifetime.closedAtEpochMs === null
            ? null
            : decodeLiveRtcNativeState('closeState' in lifetime ? lifetime.closeState : null),
        observedAtEpochMs: lifetime.observedAtEpochMs,
        observation: lifetime.observation === 'live'
            ? 'live'
            : lifetime.observation === 'collected'
            ? 'collected'
            : 'unavailable',
        state: decodeLiveRtcNativeState(lifetime.observation === 'live' && 'state' in lifetime ? lifetime.state : null)
    };
}

function decodeLiveRtcSignalingReceived(received: unknown): LiveRtcSignalingObservation.Received | null {
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
        msgId: decodeLiveRtcIdentity('msgId' in received ? received.msgId : null),
        signalType: received.signalType,
        offerId: decodeLiveRtcIdentity('offerId' in received ? received.offerId : null),
        fromId: decodeLiveRtcIdentity('fromId' in received ? received.fromId : null),
        toId: decodeLiveRtcIdentity('toId' in received ? received.toId : null),
        receivedAtEpochMs: received.receivedAtEpochMs
    };
}

function decodeLiveRtcSignalingAttempt(attempt: unknown): LiveRtcSignalingObservation.Attempt | null {
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
        msgId: decodeLiveRtcIdentity('msgId' in attempt ? attempt.msgId : null),
        nativeInstanceOrdinal: attempt.nativeInstanceOrdinal,
        signalType: 'signalType' in attempt && (attempt.signalType === 'Offer' || attempt.signalType === 'Answer')
            ? attempt.signalType
            : null,
        offerId: decodeLiveRtcIdentity('offerId' in attempt ? attempt.offerId : null),
        fromId: decodeLiveRtcIdentity('fromId' in attempt ? attempt.fromId : null),
        toId: decodeLiveRtcIdentity('toId' in attempt ? attempt.toId : null),
        receivedAtEpochMs: 'receivedAtEpochMs' in attempt && typeof attempt.receivedAtEpochMs === 'number' &&
                Number.isFinite(attempt.receivedAtEpochMs)
            ? attempt.receivedAtEpochMs
            : null,
        match: attempt.match,
        attemptedAtEpochMs: attempt.attemptedAtEpochMs,
        settledAtEpochMs: attempt.settledAtEpochMs,
        settlement: attempt.settlement,
        state: decodeLiveRtcNativeState('state' in attempt ? attempt.state : null)
    };
}

function decodeLiveRtcNativeState(peer: unknown): LiveRtcSignalingObservation.NativeState {
    if (!peer || typeof peer !== 'object') {
        return { signalingState: null, connectionState: null, iceConnectionState: null };
    }
    return {
        signalingState: decodeLiveRtcAllowedState(
            'signalingState' in peer ? peer.signalingState : null,
            ['stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed']
        ),
        connectionState: decodeLiveRtcAllowedState(
            'connectionState' in peer ? peer.connectionState : null,
            ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']
        ),
        iceConnectionState: decodeLiveRtcAllowedState(
            'iceConnectionState' in peer ? peer.iceConnectionState : null,
            ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']
        )
    };
}

function decodeLiveRtcIdentity(value: unknown): string | null {
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

function decodeLiveRtcAllowedState(value: unknown, allowed: readonly string[]): string | null {
    return typeof value === 'string' && allowed.includes(value) ? value : null;
}
