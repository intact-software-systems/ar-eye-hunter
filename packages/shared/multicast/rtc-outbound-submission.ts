import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALQosInputProvider } from '../al-contracts/al-policy.ts';
import {
    AL_SUBMISSION_NOT_READY_RETRY_MS,
    writeALOutboundCongestionDeferral,
    type ALOutboundMessageRuntime,
    type ALOutboundPreparedSendResult,
    type ALOutboundRuntimeDiagnosticsSink,
    type ALOutboundSettledSendResult
} from '../alm/outbound/al-outbound-message-runtime.ts';
import type { TransportFaultPort } from '../transport-faults/transport-fault-port.ts';
import type { QRtcDataChannel, RtcDataChannelHealth } from '../webrtc/qrtc-data-channel.ts';
import { computeRtcBackpressure } from './compute-rtc-backpressure.ts';
import type { WebRtcOverlayMulticastManager } from './web-rtc-overlay-multicast-manager.ts';

export namespace RtcOutboundSubmission {
    export interface Dependencies {
        readonly connectionService: WebRtcOverlayMulticastManager.Connection;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly faultPort: TransportFaultPort;
        /** The overlay's provider, whose priority a deferral names. */
        readonly qosProvider: ALQosInputProvider;
        /** The overlay's outbound diagnostics, where a send held back by backpressure reports it (D186). */
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
    }
}

/** Translates an authorized next hop into native RTC submission and its settlement. */
export class RtcOutboundSubmission {
    private readonly dependencies: RtcOutboundSubmission.Dependencies;

    constructor(dependencies: RtcOutboundSubmission.Dependencies) {
        this.dependencies = dependencies;
    }

    send(msg: ALMessage, lifecycle: ALOutboundMessageRuntime.SendLifecycle): ALOutboundPreparedSendResult {
        const peerId = msg.forwarding?.nextHopPeerIds?.[0];
        if (!peerId) {
            return {
                status: 'no-targets',
                submissionAttempted: false,
                reason: 'Skipping RTC send without immediate next hop'
            };
        }

        const peer = this.dependencies.connectionService.readPeer(peerId);
        if (!peer?.channel) {
            return {
                status: 'not-ready',
                submissionAttempted: false,
                reason: `No RTC channel for peer ${peerId}`,
                retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS
            };
        }

        const health = peer.channel.readHealth();
        if (health.readyState !== 'open') {
            return {
                status: 'not-ready',
                submissionAttempted: false,
                reason: `RTC channel for peer ${peerId} is ${health.readyState}`,
                retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS
            };
        }
        if (this.dependencies.faultPort.decideBackpressure('rtc', msg)) {
            return this.deferBackpressuredSend(msg, peerId);
        }

        return this.submitPreparedMessage(
            { peerId, channel: peer.channel, flowControl: health.flowControl },
            msg,
            lifecycle
        );
    }

    /**
     * A send the channel cannot take now, which its `drop-new` overflow drops at the high watermark, waits for its
     * next attempt and reports the deferral (D186).
     */
    private deferBackpressuredSend(msg: ALMessage, peerId: string): ALOutboundPreparedSendResult {
        writeALOutboundCongestionDeferral({
            diagnostics: this.dependencies.diagnostics,
            carrier: 'rtc',
            message: msg,
            selfPeerId: this.dependencies.connectionService.input.sessionId,
            qosProvider: this.dependencies.qosProvider
        });
        return {
            status: 'not-ready',
            submissionAttempted: false,
            reason: `RTC channel for peer ${peerId} is backpressured`,
            retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS
        };
    }

    private submitPreparedMessage(
        hop: RtcSubmissionHop,
        msg: ALMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): ALOutboundPreparedSendResult {
        // The native Promise executor initializes the callback synchronously before sendJson can invoke it.
        let resolveSettlement!: (value: QRtcDataChannel.SendSettlement) => void;
        const settled = new Promise<QRtcDataChannel.SendSettlement>((resolve) => {
            resolveSettlement = resolve;
        });
        const expiresAtEpochMs = Math.min(lifecycle.expiresAtMs ?? Infinity, lifecycle.leaseUntilMs ?? Infinity);
        const result = hop.channel.sendJson(msg, {
            signal: lifecycle.signal,
            expiresAtEpochMs: Number.isFinite(expiresAtEpochMs) ? expiresAtEpochMs : undefined,
            onSettled: resolveSettlement
        });
        if (result.status === 'queued' || result.status === 'replaced') {
            return {
                status: 'queued',
                settled: settled.then((value) =>
                    toALOutboundRtcSettlement({
                        status: value.status,
                        submissionAttempted: value.submissionAttempted,
                        reason: value.reason,
                        messageExpiresAtMs: lifecycle.expiresAtMs,
                        observedAtMs: this.dependencies.clock.nowMs()
                    })
                )
            };
        }
        if (result.status === 'dropped' && computeRtcBackpressure([{ ...result, flowControl: hop.flowControl }])) {
            return this.deferBackpressuredSend(msg, hop.peerId);
        }
        return toALOutboundRtcSettlement({
            status: result.status,
            submissionAttempted: result.status === 'sent',
            reason: result.reason,
            messageExpiresAtMs: lifecycle.expiresAtMs,
            observedAtMs: this.dependencies.clock.nowMs()
        });
    }
}

/** The next hop a submission writes to, with the flow control its channel drops an overflowing send by. */
interface RtcSubmissionHop {
    readonly peerId: string;
    readonly channel: WebRtcOverlayMulticastManager.Channel;
    readonly flowControl: RtcDataChannelHealth['flowControl'];
}

interface ALOutboundRtcSettlementInput {
    readonly status: QRtcDataChannel.SendSettlement['status'];
    readonly submissionAttempted: boolean;
    readonly reason: string | undefined;
    readonly messageExpiresAtMs: number | undefined;
    readonly observedAtMs: number;
}

function toALOutboundRtcSettlement(input: ALOutboundRtcSettlementInput): ALOutboundSettledSendResult {
    const { status, submissionAttempted, reason, messageExpiresAtMs, observedAtMs } = input;
    if (status === 'expired' && (messageExpiresAtMs === undefined || observedAtMs < messageExpiresAtMs)) {
        return {
            status: 'not-ready',
            submissionAttempted,
            reason: 'RTC attempt lease elapsed before native submission.',
            retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS
        };
    }
    if (status === 'failed' && submissionAttempted) {
        return { status: 'failed', submissionAttempted, reason, retryAfterMs: 50 };
    }
    if (status === 'dropped' || status === 'closed' || status === 'failed') {
        return { status: 'not-ready', submissionAttempted, reason, retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS };
    }
    return { status, submissionAttempted, reason };
}
