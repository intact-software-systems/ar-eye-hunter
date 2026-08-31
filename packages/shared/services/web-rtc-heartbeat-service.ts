import { QRtcDataChannel } from '../webrtc/qrtc-data-channel.ts';

export const defaultMaxMissedPings = 5;
export const defaultPingFrequencyMsecs = 5000;

const pingMessageType = 'ping';

interface PingPayload {
    readonly type: 'ping';
    readonly pingType: 'ping' | 'pong';
    readonly ts: number;
}

export interface PingResult {
    readonly peerSessionId: string;
    readonly rttMsecs: number;
    readonly version: number;
}

export namespace WebRtcHeartbeatService {
    export interface InputDto {
        readonly sessionId: string;
        readonly peerSessionId: string;
        readonly channel: QRtcDataChannel;
        readonly maxMissedPings: number;
        readonly pingFrequencyMsecs: number;
    }

    export interface Callbacks {
        readonly onHeartbeat: (result: PingResult) => Promise<void>;
        readonly onMissedHeartbeat: (peerId: string) => Promise<void>;
    }

    export interface Status {
        pingInterval: ReturnType<typeof setInterval> | undefined;
        missedPings: number;
    }
}

export class WebRtcHeartbeatService {
    private readonly status: WebRtcHeartbeatService.Status;

    private messageCallbackId: string | undefined;
    private reportingCallbacks: WebRtcHeartbeatService.Callbacks | undefined;
    private versionCounter = 1;

    public readonly input: WebRtcHeartbeatService.InputDto;

    constructor(
        input: WebRtcHeartbeatService.InputDto
    ) {
        this.input = input;
        this.status = {
            pingInterval: undefined,
            missedPings: 0
        };
    }

    start(callbacks: WebRtcHeartbeatService.Callbacks): void {
        if (this.status.pingInterval) {
            return;
        }

        this.startResponding();
        this.reportingCallbacks = callbacks;
        this.status.missedPings = 0;
        this.status.pingInterval = setInterval(
            () => this.writeHeartbeatPing(callbacks),
            this.input.pingFrequencyMsecs
        );
    }

    startResponding(): void {
        if (this.messageCallbackId !== undefined) {
            return;
        }

        this.messageCallbackId = this.input.peerSessionId + '-heartbeat';
        this.input.channel.onRtcMessageDo(
            this.messageCallbackId,
            {
                onMessage: async (value) => {
                    if (isHeartbeatMessage(value)) {
                        await this.receiveHeartbeatMessage(value);
                    }
                }
            },
            pingMessageType
        );
    }

    stopReporting(): void {
        if (this.status.pingInterval) {
            clearInterval(this.status.pingInterval);
            this.status.pingInterval = undefined;
        }
        this.reportingCallbacks = undefined;
        this.status.missedPings = 0;
    }

    stop(): void {
        this.stopReporting();

        if (this.messageCallbackId) {
            this.input.channel.removeOnRtcMessageCallbackById(
                this.messageCallbackId
            );
            this.messageCallbackId = undefined;
        }
    }

    private async receiveHeartbeatMessage(message: PingPayload): Promise<void> {
        try {
            if (message.pingType === 'ping') {
                await this.input.channel.sendAsJsonString(JSON.stringify(
                    {
                        type: pingMessageType,
                        pingType: 'pong',
                        ts: message.ts
                    } satisfies PingPayload
                ));
            }
            else if (this.reportingCallbacks) {
                this.status.missedPings = 0;
                const rttMsecs = Math.round(performance.now() - message.ts);
                await this.reportingCallbacks.onHeartbeat({
                    peerSessionId: this.input.peerSessionId,
                    rttMsecs,
                    version: ++this.versionCounter
                });
            }
        }
        catch (error) {
            console.error('Failed to process RTC heartbeat message', error);
        }
    }

    private async writeHeartbeatPing(callbacks: WebRtcHeartbeatService.Callbacks): Promise<void> {
        if (!this.input.channel.isOpen()) {
            this.stop();
            return;
        }
        if (this.status.missedPings >= this.input.maxMissedPings) {
            await callbacks.onMissedHeartbeat(this.input.peerSessionId);
            return;
        }

        this.status.missedPings++;
        await this.input.channel.sendAsJsonString(JSON.stringify(
            {
                type: pingMessageType,
                pingType: 'ping',
                ts: performance.now()
            } satisfies PingPayload
        ));
    }
}

function isHeartbeatMessage(value: unknown): value is PingPayload {
    return typeof value === 'object' && value !== null &&
        'type' in value && value.type === 'ping' &&
        'pingType' in value && (value.pingType === 'ping' || value.pingType === 'pong') &&
        'ts' in value && typeof value.ts === 'number' && Number.isFinite(value.ts);
}
