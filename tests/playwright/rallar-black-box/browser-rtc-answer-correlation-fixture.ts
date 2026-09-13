import { QRtcPeerConnection } from '../../../packages/shared/webrtc/qrtc-peer-connection.ts';
import type {
    QRtcSignal,
    QRtcSignalingMessage,
    QRtcSignalingSender
} from '../../../packages/shared/webrtc/qrtc-signaling-contracts.ts';

export interface BrowserRtcAnswerCorrelationResult {
    readonly delayedOldAnswer: boolean;
    readonly distinctOfferIds: boolean;
    readonly oldAnswerDelivered: boolean;
    readonly signalingAfterOldAnswer: RTCSignalingState | undefined;
    readonly oldDescriptionSelected: boolean;
    readonly currentAnswerMatchesOffer: boolean;
    readonly signalingAfterCurrentAnswer: RTCSignalingState | undefined;
    readonly channelState: RTCDataChannelState;
    readonly receivedPayload: string | undefined;
    readonly observationLimitMs: number;
    readonly timedOut: boolean;
    readonly cleanupErrors: readonly string[];
}

interface AnswerCorrelationObservation {
    readonly previous: NativeRtcPair;
    readonly current: NativeRtcPair;
    readonly delayedOldAnswer: boolean;
    readonly observation: AbortController;
    readonly cleanupErrors: string[];
}

class CapturedRtcSignaling implements QRtcSignalingSender {
    readonly descriptions: QRtcSignalingMessage[] = [];
    readonly events = new EventTarget();
    readonly peers = new Map<string, QRtcPeerConnection>();

    async send(message: QRtcSignalingMessage): Promise<void> {
        if (message.signalType === 'IceCandidate') {
            const peer = this.peers.get(message.toId);
            if (peer) {
                await peer.handleSignal(message);
            }
            return;
        }
        this.descriptions.push(message);
        this.events.dispatchEvent(new Event('description'));
    }

    async readDescription<Type extends 'Offer' | 'Answer'>(
        signalType: Type,
        signal: AbortSignal
    ): Promise<Extract<QRtcSignal, { signalType: Type; }>> {
        while (true) {
            signal.throwIfAborted();
            const description = this.descriptions.find((message) => message.signalType === signalType);
            if (description?.signalType === signalType) {
                return description as Extract<QRtcSignal, { signalType: Type; }>;
            }
            await readNativeEvent(this.events, 'description', signal);
        }
    }
}

class NativeRtcPair {
    readonly signaling = new CapturedRtcSignaling();
    readonly left: QRtcPeerConnection;
    readonly right: QRtcPeerConnection;
    readonly channels: RTCDataChannel[] = [];
    readonly events = new EventTarget();
    channel: RTCDataChannel | undefined;
    receivedPayload: string | undefined;

    constructor(createOfferId: () => string) {
        this.left = new QRtcPeerConnection(this.signaling, {
            sessionId: 'native-left',
            token: '',
            peerSessionId: 'native-right',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Number.MAX_SAFE_INTEGER },
            isPolite: false
        }, { createOfferId });
        this.right = new QRtcPeerConnection(this.signaling, {
            sessionId: 'native-right',
            token: '',
            peerSessionId: 'native-left',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Number.MAX_SAFE_INTEGER },
            isPolite: true
        }, { createOfferId });
        this.signaling.peers.set('native-left', this.left);
        this.signaling.peers.set('native-right', this.right);
        this.right.onDataChannelDo('native-answer-proof', async (event) => {
            this.channels.push(event.channel);
            event.channel.onmessage = (message) => {
                if (typeof message.data === 'string') {
                    this.receivedPayload = message.data;
                    this.events.dispatchEvent(new Event('payload'));
                }
            };
        });
    }

    start(signal: AbortSignal): void {
        signal.throwIfAborted();
        this.left.connect();
        this.right.connect();
        this.channel = this.left.createDataChannel('native-answer-proof');
        this.channels.push(this.channel);
    }

    async readAnswer(signal: AbortSignal): Promise<Extract<QRtcSignal, { signalType: 'Answer'; }>> {
        const offer = await this.signaling.readDescription('Offer', signal);
        signal.throwIfAborted();
        await this.right.handleSignal(offer);
        signal.throwIfAborted();
        return await this.signaling.readDescription('Answer', signal);
    }

    async writePayload(signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        const channel = this.channel;
        if (!channel) {
            throw new Error('Native proof channel was not started');
        }
        if (channel.readyState !== 'open') {
            await readNativeEvent(channel, 'open', signal);
        }
        signal.throwIfAborted();
        channel.send('current-answer-native-payload');
        if (this.receivedPayload === undefined) {
            await readNativeEvent(this.events, 'payload', signal);
        }
    }

    close(cleanupErrors: string[]): void {
        this.signaling.peers.clear();
        for (const channel of this.channels) {
            try {
                channel.onmessage = null;
                channel.close();
            }
            catch (error) {
                cleanupErrors.push(error instanceof Error ? error.name : 'ChannelCloseError');
            }
        }
        for (const peer of [this.left, this.right]) {
            const nativePeer = peer.status.pc;
            try {
                peer.reset();
                if (nativePeer && nativePeer.signalingState !== 'closed') {
                    cleanupErrors.push('NativePeerNotClosed');
                }
            }
            catch (error) {
                cleanupErrors.push(error instanceof Error ? error.name : 'PeerCloseError');
            }
        }
    }
}

export async function runBrowserRtcAnswerCorrelation(
    delayedOldAnswer: boolean
): Promise<BrowserRtcAnswerCorrelationResult> {
    let offerSequence = 0;
    const createOfferId = () => `native-offer-${++offerSequence}`;
    const previous = new NativeRtcPair(createOfferId);
    const current = new NativeRtcPair(createOfferId);
    const observation = new AbortController();
    const cleanupErrors: string[] = [];
    const deadline = new Promise<never>((_resolve, reject) => {
        observation.signal.addEventListener('abort', () => {
            reject(new Error('Native RTC observation exceeded 5000 ms'));
        }, { once: true });
    });
    const timeout = setTimeout(() => observation.abort(), 5000);
    try {
        return await Promise.race([
            observeAnswerCorrelation({ previous, current, delayedOldAnswer, observation, cleanupErrors }),
            deadline
        ]);
    }
    finally {
        clearTimeout(timeout);
        observation.abort();
        previous.close(cleanupErrors);
        current.close(cleanupErrors);
    }
}

async function observeAnswerCorrelation(
    observation: AnswerCorrelationObservation
): Promise<BrowserRtcAnswerCorrelationResult> {
    const { previous, current, delayedOldAnswer, cleanupErrors } = observation;
    const signal = observation.observation.signal;
    let oldAnswer: Extract<QRtcSignal, { signalType: 'Answer'; }> | undefined;
    if (delayedOldAnswer) {
        previous.start(signal);
        oldAnswer = await previous.readAnswer(signal);
        signal.throwIfAborted();
        previous.close(cleanupErrors);
    }
    current.start(signal);
    const currentAnswer = await current.readAnswer(signal);
    const currentOffer = await current.signaling.readDescription('Offer', signal);
    if (oldAnswer) {
        await current.left.handleSignal(oldAnswer);
        signal.throwIfAborted();
    }
    const signalingAfterOldAnswer = current.left.status.pc?.signalingState;
    const oldDescriptionSelected = oldAnswer !== undefined &&
        current.left.status.pc?.remoteDescription?.type === 'answer';
    await current.left.handleSignal(currentAnswer);
    signal.throwIfAborted();
    const signalingAfterCurrentAnswer = current.left.status.pc?.signalingState;
    await current.writePayload(signal);
    return {
        delayedOldAnswer,
        distinctOfferIds: oldAnswer !== undefined && oldAnswer.offerId !== currentOffer.offerId,
        oldAnswerDelivered: oldAnswer !== undefined,
        signalingAfterOldAnswer,
        oldDescriptionSelected,
        currentAnswerMatchesOffer: currentAnswer.offerId === currentOffer.offerId,
        signalingAfterCurrentAnswer,
        channelState: current.channel?.readyState ?? 'closed',
        receivedPayload: current.receivedPayload,
        observationLimitMs: 5000,
        timedOut: signal.aborted,
        cleanupErrors
    };
}

async function readNativeEvent(target: EventTarget, event: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const finish = () => {
            target.removeEventListener(event, finish);
            signal.removeEventListener('abort', abort);
            resolve();
        };
        const abort = () => {
            target.removeEventListener(event, finish);
            reject(new Error('Native RTC observation exceeded 5000 ms'));
        };
        target.addEventListener(event, finish, { once: true });
        signal.addEventListener('abort', abort, { once: true });
    });
}
