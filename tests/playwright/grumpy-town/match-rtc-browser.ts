export interface GrumpyTownRtcTrial {
    received: number;
    setBlocked(blocked: boolean): void;
}

declare global {
    interface Window {
        __grumpyTownRtcTrial: GrumpyTownRtcTrial;
    }
}

/** Native channel observation and failure injection; installed before the application. */
export function installGrumpyTownRtcTrial(): void {
    const channels = new Set<RTCDataChannel>();
    let blocked = false;
    const trial: GrumpyTownRtcTrial = {
        received: 0,
        setBlocked(value) {
            blocked = value;
            if (blocked) {
                channels.forEach((channel) => channel.close());
            }
        }
    };
    const track = (channel: RTCDataChannel): void => {
        if (channel.label !== 'rtc-realtime') {
            return;
        }
        channels.add(channel);
        channel.addEventListener('message', () => {
            trial.received += 1;
        });
        channel.addEventListener('close', () => channels.delete(channel), { once: true });
        if (blocked) {
            channel.close();
        }
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
    window.__grumpyTownRtcTrial = trial;
}
