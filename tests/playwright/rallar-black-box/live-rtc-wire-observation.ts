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
    readonly messageId: string;
    readonly senderSessionId: string;
    readonly targetSessionId: string;
}

export function hasLiveRtcNotYetInSyncNack(
    input: LiveRtcReceivedNackProbe
): boolean {
    return input.frames.some((frame) => {
        let message;
        try {
            message = jsonRecord(normalizeJson(JSON.parse(frame)));
        }
        catch {
            return false;
        }
        const payload = jsonRecord(message?.payload);
        const resource = stringValue(payload?.resource);
        if (payload?.typeId !== 'al.control.nack.v1' || !resource) {
            return false;
        }
        try {
            const nack = jsonRecord(normalizeJson(JSON.parse(resource)));
            return nack?.msgId === input.messageId && nack.reason === 'not-yet-in-sync' &&
                nack.fromPeerId === input.targetSessionId && nack.toPeerId === input.senderSessionId;
        }
        catch {
            return false;
        }
    });
}
