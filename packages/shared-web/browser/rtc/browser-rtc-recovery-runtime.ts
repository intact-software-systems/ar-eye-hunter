import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarRtcReconnectOptions,
    RallarRtcRecoveryResult,
    RallarRtcRecoveryStatus,
    RallarRtcStatus,
    RallarRtcWaitForOpenOptions,
    RallarRtcWaitForOpenResult
} from '@shared-web/browser/rallar-rtc-facade.ts';

interface RallarRtcRecoveryResultInput {
    readonly peerId: string;
    readonly action: RallarRtcRecoveryResult['action'];
    readonly status: RallarRtcRecoveryStatus;
    readonly reason?: string;
}

export namespace BrowserRtcRecoveryRuntime {
    export interface Input {
        readMiddleware(): ApiMiddleware | undefined;
        readStatus(): RallarRtcStatus;
        waitForLane(
            peerId: string,
            laneId: string,
            options: RallarRtcWaitForOpenOptions
        ): Promise<RallarRtcWaitForOpenResult>;
    }
}

/** Owns explicit RTC ICE restart and peer reconnection policy. */
export class BrowserRtcRecoveryRuntime {
    private readonly input: BrowserRtcRecoveryRuntime.Input;

    public constructor(input: BrowserRtcRecoveryRuntime.Input) {
        this.input = input;
    }

    public async restartIce(peerId: string): Promise<RallarRtcRecoveryResult> {
        const context = this.input.readMiddleware();
        if (!context) {
            return this.toResult({
                peerId,
                action: 'restart-ice',
                status: 'not-connected',
                reason: 'Rallar is not connected.'
            });
        }

        const peer = context.middleware.webRtcConnectionService.readPeer(peerId);
        if (!peer) {
            return this.toResult({
                peerId,
                action: 'restart-ice',
                status: 'no-peer',
                reason: `RTC peer ${peerId} is not known.`
            });
        }

        const peerConnection = peer.connection.status.pc;
        if (!peerConnection || typeof peerConnection.restartIce !== 'function') {
            return this.toResult({
                peerId,
                action: 'restart-ice',
                status: 'unsupported',
                reason: `RTC peer ${peerId} does not expose restartIce().`
            });
        }

        try {
            peerConnection.restartIce();
            return this.toResult({
                peerId,
                action: 'restart-ice',
                status: 'restarted'
            });
        }
        catch (error) {
            return this.toResult({
                peerId,
                action: 'restart-ice',
                status: 'failed',
                reason: toErrorMessage(error)
            });
        }
    }

    public async reconnectPeer(
        peerId: string,
        options: RallarRtcReconnectOptions = {}
    ): Promise<RallarRtcRecoveryResult> {
        const context = this.input.readMiddleware();
        if (!context) {
            return this.toResult({
                peerId,
                action: 'reconnect',
                status: 'not-connected',
                reason: 'Rallar is not connected.'
            });
        }

        try {
            context.middleware.webRtcConnectionService.disconnectPeer(peerId);
            if (options.laneId) {
                const result = await this.input.waitForLane(
                    peerId,
                    options.laneId,
                    {
                        ...options,
                        connect: true
                    }
                );
                return this.toResult({
                    peerId,
                    action: 'reconnect',
                    status: result.status === 'open' ? 'started' : 'failed',
                    reason: result.reason
                });
            }

            const started = context.middleware.webRtcConnectionService
                .ensurePeerConnectionStarted(peerId);
            if (started.left) {
                return this.toResult({
                    peerId,
                    action: 'reconnect',
                    status: 'failed',
                    reason: started.left.kind
                });
            }

            return this.toResult({ peerId, action: 'reconnect', status: 'started' });
        }
        catch (error) {
            return this.toResult({
                peerId,
                action: 'reconnect',
                status: 'failed',
                reason: toErrorMessage(error)
            });
        }
    }

    private toResult(input: RallarRtcRecoveryResultInput): RallarRtcRecoveryResult {
        return {
            peerId: input.peerId,
            action: input.action,
            status: input.status,
            rtcStatus: this.input.readStatus(),
            reason: input.reason
        };
    }
}

function toErrorMessage(error: Error['cause']): string {
    return error instanceof Error ? error.message : String(error);
}
