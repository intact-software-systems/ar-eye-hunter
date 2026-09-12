import type { ALMessage } from '../al-contracts/al-contract.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundPreparedSendResult,
    ALOutboundSettledSendResult
} from '../alm/outbound/al-outbound-message-runtime.ts';
import type { QRtcDataChannel } from '../webrtc/qrtc-data-channel.ts';
import type { WebRtcOverlayMulticastManager } from './web-rtc-overlay-multicast-manager.ts';

/** Translates an authorized next hop into native RTC submission and its settlement. */
export class RtcOutboundSubmission {
    private readonly connectionService: WebRtcOverlayMulticastManager.Connection;
    private readonly clock: ALOutboundMessageRuntime.Clock;

    constructor(connectionService: WebRtcOverlayMulticastManager.Connection, clock: ALOutboundMessageRuntime.Clock) {
        this.connectionService = connectionService;
        this.clock = clock;
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

        const peer = this.connectionService.readPeer(peerId);
        if (!peer?.channel) {
            return {
                status: 'not-ready',
                submissionAttempted: false,
                reason: `No RTC channel for peer ${peerId}`,
                retryAfterMs: 50
            };
        }

        const health = peer.channel.readHealth();
        if (health.readyState !== 'open') {
            return {
                status: 'not-ready',
                submissionAttempted: false,
                reason: `RTC channel for peer ${peerId} is ${health.readyState}`,
                retryAfterMs: 50
            };
        }

        return this.submitPreparedMessage(peer.channel, msg, lifecycle);
    }
    private submitPreparedMessage(
        channel: WebRtcOverlayMulticastManager.Channel,
        msg: ALMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): ALOutboundPreparedSendResult {
        // The native Promise executor initializes the callback synchronously before sendJson can invoke it.
        let resolveSettlement!: (value: QRtcDataChannel.SendSettlement) => void;
        const settled = new Promise<QRtcDataChannel.SendSettlement>((resolve) => {
            resolveSettlement = resolve;
        });
        const expiresAtEpochMs = Math.min(lifecycle.expiresAtMs ?? Infinity, lifecycle.leaseUntilMs ?? Infinity);
        const result = channel.sendJson(msg, {
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
                        observedAtMs: this.clock.nowMs()
                    })
                )
            };
        }
        return toALOutboundRtcSettlement({
            status: result.status,
            submissionAttempted: result.status === 'sent',
            reason: result.reason,
            messageExpiresAtMs: lifecycle.expiresAtMs,
            observedAtMs: this.clock.nowMs()
        });
    }
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
            retryAfterMs: 50
        };
    }
    if (status === 'failed' && submissionAttempted) {
        return { status: 'failed', submissionAttempted, reason, retryAfterMs: 50 };
    }
    if (status === 'dropped' || status === 'closed' || status === 'failed') {
        return { status: 'not-ready', submissionAttempted, reason, retryAfterMs: 50 };
    }
    return { status, submissionAttempted, reason };
}
