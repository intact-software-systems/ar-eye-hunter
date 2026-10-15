import type { ALMessage } from '../al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID } from '../al-contracts/al-control-type-ids.ts';
import type { ALQosInputProvider } from '../al-contracts/al-policy.ts';
import {
    AL_SUBMISSION_NOT_READY_RETRY_MS,
    writeALOutboundCongestionDeferral,
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundMessageRuntime,
    type ALOutboundPreparedSendResult,
    type ALOutboundRuntimeDiagnosticsSink,
    type ALOutboundSettledSendResult
} from '../alm/outbound/al-outbound-message-runtime.ts';
import { toError } from '../resilience/to-error.ts';
import type { TransportFaultPort } from '../transport-faults/transport-fault-port.ts';
import type { QRtcDataChannel, RtcDataChannelHealth } from '../webrtc/qrtc-data-channel.ts';
import { computeRtcBackpressure } from './compute-rtc-backpressure.ts';
import type { WebRtcOverlayMulticastManager } from './web-rtc-overlay-multicast-manager.ts';

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
    private queuedBytesHighWater = 0;

    constructor(dependencies: RtcOutboundSubmission.Dependencies) {
        this.dependencies = dependencies;
    }

    async send(
        msg: ALMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundPreparedSendResult> {
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
        this.observeQueuedBytes(health.bufferedAmount);
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

    /** Only a new high is reported, so a page reads the session's peak queue without one diagnostic per send. */
    private observeQueuedBytes(queuedBytes: number): void {
        if (queuedBytes <= this.queuedBytesHighWater) {
            return;
        }
        this.queuedBytesHighWater = queuedBytes;
        writeALOutboundRuntimeDiagnostic(this.dependencies.diagnostics, {
            kind: 'rtc-queued-bytes-high-water',
            queuedBytes
        });
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

    private async submitPreparedMessage(
        hop: RtcSubmissionHop,
        msg: ALMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundPreparedSendResult> {
        // Native Promise executors initialize their resolver before sendJson can schedule its observer.
        let resolveSettlement!: (value: QRtcDataChannel.SendSettlement) => void;
        const settled = new Promise<QRtcDataChannel.SendSettlement>((resolve) => {
            resolveSettlement = resolve;
        });
        let observedSettlement: QRtcDataChannel.SendSettlement | undefined;
        const onSettled = this.toSettlementObserver(msg, hop.peerId, (value) => {
            observedSettlement = value;
            resolveSettlement(value);
        });
        const expiresAtEpochMs = Math.min(lifecycle.expiresAtMs ?? Infinity, lifecycle.leaseUntilMs ?? Infinity);
        let disposition: QRtcDataChannel.SendDisposition;
        try {
            const result = hop.channel.sendJson(msg, {
                signal: lifecycle.signal,
                expiresAtEpochMs: Number.isFinite(expiresAtEpochMs) ? expiresAtEpochMs : undefined,
                onSettled
            });
            if (result.status === 'queued' || result.status === 'replaced') {
                return {
                    status: 'queued',
                    settled: settled.then((value) =>
                        toALOutboundRtcSettlement({
                            ...value,
                            messageExpiresAtMs: lifecycle.expiresAtMs,
                            observedAtMs: this.dependencies.clock.nowMs()
                        })
                    )
                };
            }
            if (result.status === 'dropped' && computeRtcBackpressure([{ ...result, flowControl: hop.flowControl }])) {
                return this.deferBackpressuredSend(msg, hop.peerId);
            }
            disposition = {
                status: result.status,
                submissionAttempted: result.status === 'sent',
                reason: result.reason
            };
        }
        catch (error) {
            // QR schedules its terminal observer before rethrowing; reconcile that owned microtask once.
            await Promise.resolve();
            if (observedSettlement?.status !== 'failed' || !observedSettlement.submissionAttempted) {
                throw error;
            }
            disposition = { ...observedSettlement, reason: toError(error).message };
        }
        return toALOutboundRtcSettlement({
            ...disposition,
            messageExpiresAtMs: lifecycle.expiresAtMs,
            observedAtMs: this.dependencies.clock.nowMs()
        });
    }

    private toSettlementObserver(
        msg: ALMessage,
        peerId: string,
        resolveSettlement: (value: QRtcDataChannel.SendSettlement) => void
    ): (value: QRtcDataChannel.SendSettlement) => void {
        try {
            const diagnostics = this.dependencies.diagnostics;
            if (diagnostics && msg.payload.typeId === AL_CONTROL_ACK_TYPE_ID) {
                const identity = {
                    controlMsgId: msg.id.msgId,
                    controlSenderId: msg.id.senderId,
                    fromPeerId: this.dependencies.connectionService.input.sessionId,
                    toPeerId: peerId
                };
                return (value) => {
                    resolveSettlement(value);
                    try {
                        writeALOutboundRuntimeDiagnostic(diagnostics, {
                            kind: 'rtc-ack-submission',
                            ...identity,
                            carrier: 'rtc',
                            status: value.status,
                            submissionAttempted: value.submissionAttempted,
                            observedAtEpochMs: this.dependencies.clock.nowMs()
                        });
                    }
                    catch { /* Optional projection and clock cannot replace mandatory settlement. */ }
                };
            }
        }
        catch { /* Without a usable observer, retain the original settlement callback. */ }
        return resolveSettlement;
    }
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
