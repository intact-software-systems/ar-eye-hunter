import {
    jsonRecord,
    normalizeJson,
    stringValue
} from './live-rtc-evidence-json.ts';

export interface LiveRtcWireObservation {
    start(): void;
    read(): readonly string[];
    stop(): void;
}

declare global {
    interface Window {
        __liveRtcWireObservation?: LiveRtcWireObservation;
    }
}

/** Serialized by Playwright before app startup; contains no imported runtime dependencies. */
export function installLiveRtcWireObservation(): void {
    const channels = new Set<RTCDataChannel>();
    const frames: string[] = [];
    let active = false;
    const receive = (event: MessageEvent) => {
        if (typeof event.data === 'string' && frames.length <= 1_000) {
            frames.push(event.data);
        }
    };
    const track = (channel: RTCDataChannel) => {
        channels.add(channel);
        if (active) {
            channel.addEventListener('message', receive);
        }
        channel.addEventListener('close', () => {
            channels.delete(channel);
            channel.removeEventListener('message', receive);
        }, { once: true });
    };
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
        constructor(configuration?: RTCConfiguration) {
            super(configuration);
            this.addEventListener('datachannel', (event) => track(event.channel));
        }
        override createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
            const channel = super.createDataChannel(label, options);
            track(channel);
            return channel;
        }
    };
    window.__liveRtcWireObservation = {
        start: () => {
            frames.length = 0;
            active = true;
            channels.forEach((channel) => channel.addEventListener('message', receive));
        },
        read: () => {
            if (frames.length > 1_000) {
                throw new Error('RTC wire observation exceeded its frame limit.');
            }
            return [...frames];
        },
        stop: () => {
            active = false;
            channels.forEach((channel) => channel.removeEventListener('message', receive));
            frames.length = 0;
        }
    };
}

export interface LiveRtcReceivedNackProbe {
    readonly frames: readonly string[];
    readonly messageId: string | null;
    readonly senderSessionId: string;
    readonly targetSessionId: string;
}

export interface LiveRtcNackWireFrameSummary {
    readonly hasMessageId: boolean;
    readonly messageIdMatchesProbe: boolean;
    readonly reason: 'not-yet-in-sync' | 'other' | null;
    readonly hasFromPeerId: boolean;
    readonly fromPeerIdMatchesTarget: boolean;
    readonly hasToPeerId: boolean;
    readonly toPeerIdMatchesSender: boolean;
    readonly matchesProbe: boolean;
}

export interface LiveRtcNackWireObservationSummary {
    readonly frameCount: number;
    readonly malformedFrameCount: number;
    readonly typedFrameCount: number;
    readonly nackFrameCount: number;
    readonly malformedNackFrameCount: number;
    readonly nackFrames: readonly LiveRtcNackWireFrameSummary[];
}

interface DecodedLiveRtcWireFrame {
    readonly malformed: boolean;
    readonly typeId: string | null;
    readonly nack: LiveRtcNackWireFrameSummary | null;
}

const MAX_RETAINED_NACK_FRAME_SUMMARIES = 20;

export function hasLiveRtcNotYetInSyncNack(
    input: LiveRtcReceivedNackProbe
): boolean {
    return input.frames.some((frame) => decodeLiveRtcWireFrame(frame, input).nack?.matchesProbe === true);
}

export function summarizeLiveRtcNackWireObservation(
    input: LiveRtcReceivedNackProbe
): LiveRtcNackWireObservationSummary {
    const nackFrames: LiveRtcNackWireFrameSummary[] = [];
    let malformedFrameCount = 0;
    let typedFrameCount = 0;
    let nackFrameCount = 0;
    let malformedNackFrameCount = 0;
    for (const frame of input.frames) {
        const decoded = decodeLiveRtcWireFrame(frame, input);
        if (decoded.malformed) {
            malformedFrameCount += 1;
        }
        if (decoded.typeId) {
            typedFrameCount += 1;
        }
        if (decoded.typeId === 'al.control.nack.v1') {
            nackFrameCount += 1;
            if (!decoded.nack) {
                malformedNackFrameCount += 1;
            }
            else if (nackFrames.length < MAX_RETAINED_NACK_FRAME_SUMMARIES) {
                nackFrames.push(decoded.nack);
            }
        }
    }
    return {
        frameCount: input.frames.length,
        malformedFrameCount,
        typedFrameCount,
        nackFrameCount,
        malformedNackFrameCount,
        nackFrames
    };
}

function decodeLiveRtcWireFrame(
    frame: string,
    probe: Omit<LiveRtcReceivedNackProbe, 'frames'>
): DecodedLiveRtcWireFrame {
    let message;
    try {
        message = jsonRecord(normalizeJson(JSON.parse(frame)));
    }
    catch {
        return { malformed: true, typeId: null, nack: null };
    }
    const payload = jsonRecord(message?.payload);
    const typeId = stringValue(payload?.typeId) ?? null;
    const resource = stringValue(payload?.resource);
    if (typeId !== 'al.control.nack.v1' || !resource) {
        return { malformed: false, typeId, nack: null };
    }
    try {
        const nack = jsonRecord(normalizeJson(JSON.parse(resource)));
        if (!nack) {
            return { malformed: false, typeId, nack: null };
        }
        const messageId = stringValue(nack.msgId) ?? null;
        const reason = stringValue(nack.reason) ?? null;
        const fromPeerId = stringValue(nack.fromPeerId) ?? null;
        const toPeerId = stringValue(nack.toPeerId) ?? null;
        const messageIdMatchesProbe = probe.messageId !== null && messageId === probe.messageId;
        const fromPeerIdMatchesTarget = fromPeerId === probe.targetSessionId;
        const toPeerIdMatchesSender = toPeerId === probe.senderSessionId;
        return {
            malformed: false,
            typeId,
            nack: {
                hasMessageId: messageId !== null,
                messageIdMatchesProbe,
                reason: reason === null ? null : reason === 'not-yet-in-sync' ? reason : 'other',
                hasFromPeerId: fromPeerId !== null,
                fromPeerIdMatchesTarget,
                hasToPeerId: toPeerId !== null,
                toPeerIdMatchesSender,
                matchesProbe: messageIdMatchesProbe && reason === 'not-yet-in-sync' &&
                    fromPeerIdMatchesTarget && toPeerIdMatchesSender
            }
        };
    }
    catch {
        return { malformed: false, typeId, nack: null };
    }
}
