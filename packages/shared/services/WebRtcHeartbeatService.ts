import { QRtcDataChannel } from '../webrtc/QRtcDataChannel.ts';

export const defaultMaxMissedPings = 5;
export const defaultPingFrequencyMsecs = 5000;

type WebRtcHeartbeatServiceStatusDto = {
    pingInterval: ReturnType<typeof setInterval> | undefined;
    missedPings: number;
    lastRttMsecs: number;
};

const pingMessageType: string = 'ping';

type PingPayload = {
    type: string;
    pingType: 'ping' | 'pong';
    ts: number;
};

export type WebRtcHeartbeatCallbacks = {
    onHeartbeat: (result: PingResult) => Promise<void>;
    onMissedHeartbeat: (peerId: string) => Promise<void>;
};

export type PingResult = {
    peerSessionId: string;
    rttMsecs: number;
    version: number;
};

export type WebRtcHeartbeatServiceInputDto = {
    sessionId: string;
    peerSessionId: string;
    channel: QRtcDataChannel;
    maxMissedPings: number;
    pingFrequencyMsecs: number;
};

export class WebRtcHeartbeatService {
    private readonly status: WebRtcHeartbeatServiceStatusDto;

    private messageCallbackId: string | undefined;
    private versionCounter = 1;

    public readonly input: WebRtcHeartbeatServiceInputDto;

    constructor(
        input: WebRtcHeartbeatServiceInputDto
    ) {
        this.input = input;
        this.status = {
            pingInterval: undefined,
            missedPings: 0,
            lastRttMsecs: 0
        };
    }

    start(callbacks: WebRtcHeartbeatCallbacks): void {
        if (this.status.pingInterval) {
            console.warn('Heartbeat already started');
            return;
        }

        this.messageCallbackId = this.setupMessageHandler(this.input, callbacks);
        this.status.pingInterval = this.startHeartbeat(this.input, callbacks);
    }

    stop(): void {
        if (this.status.pingInterval) {
            clearInterval(this.status.pingInterval);
            this.status.pingInterval = undefined;
        }

        if (this.messageCallbackId) {
            this.input.channel.removeOnRtcMessageCallbackById(
                this.messageCallbackId
            );
            this.messageCallbackId = undefined;
        }
    }

    private setupMessageHandler(
        input: WebRtcHeartbeatServiceInputDto,
        callbacks: WebRtcHeartbeatCallbacks
    ): string {
        const callbackId = input.peerSessionId + '-heartbeat';
        input.channel.onRtcMessageDo(
            callbackId,
            {
                onMessage: async (data: unknown) => {
                    try {
                        const msg = data as PingPayload;

                        switch (msg.pingType) {
                            // Respond to incoming Pings from the remote peer
                            case 'ping': {
                                // Echo the exact timestamp back
                                const value: PingPayload = {
                                    type: pingMessageType,
                                    pingType: 'pong',
                                    ts: msg.ts
                                };

                                await input.channel.sendAsJsonString(
                                    JSON.stringify(value)
                                );

                                break;
                            }

                            // Process incoming Pongs to calculate RTT
                            case 'pong': {
                                this.status.missedPings = 0; // Reset failure counter

                                if (msg.ts) {
                                    // RTT = Time right now minus the time the ping was sent
                                    const rttMsecs = Math.round(performance.now() - msg.ts);

                                    this.status.lastRttMsecs = rttMsecs;

                                    console.log(`RTT to ${this.input.peerSessionId}: ${rttMsecs}ms`);

                                    await callbacks.onHeartbeat(
                                        {
                                            peerSessionId: this.input.peerSessionId,
                                            rttMsecs: rttMsecs,
                                            version: ++this.versionCounter
                                        }
                                    );
                                }
                                break;
                            }
                        }
                    }
                    catch (e) {
                        console.error('Failed to parse DataChannel message', e);
                    }
                }
            },
            pingMessageType
        );
        return callbackId;
    }

    private startHeartbeat(
        input: WebRtcHeartbeatServiceInputDto,
        callbacks: WebRtcHeartbeatCallbacks
    ): ReturnType<typeof setInterval> {
        return setInterval(
            async () => {
                if (!input.channel.isOpen()) {
                    console.log('DataChannel is closed, stopping heartbeat');
                    this.stop();
                    return;
                }

                if (this.status.missedPings >= this.input.maxMissedPings) {
                    await callbacks.onMissedHeartbeat(input.peerSessionId);
                    return;
                }

                this.status.missedPings++;

                // Use performance.now() for sub-millisecond precision
                const pingPayload: PingPayload = {
                    type: pingMessageType,
                    pingType: 'ping',
                    ts: performance.now()
                };

                await input.channel.sendAsJsonString(JSON.stringify(pingPayload));
            },
            this.input.pingFrequencyMsecs
        );
    }
}
