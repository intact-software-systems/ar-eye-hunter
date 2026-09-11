import type { ALMessage } from '../al-contracts/al-contract.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundPreparedSendResult,
    ALOutboundSettledSendResult
} from '../alm/outbound/al-outbound-message-runtime.ts';
import type { QRtcDataChannel } from '../webrtc/qrtc-data-channel.ts';
import type { WebRtcOverlayMulticastManager } from './web-rtc-overlay-multicast-manager.ts';

interface RtcChannelSubmission {
    readonly lifecycle: ALOutboundMessageRuntime.SendLifecycle;
    readonly clock: ALOutboundMessageRuntime.Clock;
}

export function writeRtcChannelMessage(
    channel: WebRtcOverlayMulticastManager.Channel,
    msg: ALMessage,
    submission: RtcChannelSubmission
): ALOutboundPreparedSendResult {
    const { lifecycle, clock } = submission;
    // Promise's executor runs synchronously, before the transport registers this completion callback.
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
                    observedAtMs: clock.nowMs()
                })
            )
        };
    }
    return toALOutboundRtcSettlement({
        status: result.status,
        submissionAttempted: result.status === 'sent',
        reason: result.reason,
        messageExpiresAtMs: lifecycle.expiresAtMs,
        observedAtMs: clock.nowMs()
    });
}

interface ALOutboundRtcSettlementInput {
    readonly status: QRtcDataChannel.SendSettlement['status'];
    readonly submissionAttempted: boolean;
    readonly reason: string | undefined;
    readonly messageExpiresAtMs: number | undefined;
    readonly observedAtMs: number;
}

function toALOutboundRtcSettlement(input: ALOutboundRtcSettlementInput): ALOutboundSettledSendResult {
    const { status, reason, messageExpiresAtMs, observedAtMs } = input;
    if (status === 'expired' && (messageExpiresAtMs === undefined || observedAtMs < messageExpiresAtMs)) {
        return { status: 'not-ready', reason: 'RTC attempt lease elapsed before native submission.', retryAfterMs: 50 };
    }
    if (status === 'failed' && input.submissionAttempted) {
        return { status: 'failed', reason, retryAfterMs: 50 };
    }
    if (status === 'dropped' || status === 'closed' || status === 'failed') {
        return { status: 'not-ready', reason, retryAfterMs: 50 };
    }
    return { status, reason };
}
