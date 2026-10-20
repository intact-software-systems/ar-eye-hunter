import { toError } from '../resilience/to-error.ts';
import type { QRtcDataChannel, RtcDataChannelHealth } from './qrtc-data-channel.ts';

export function isOpenRtcChannelHealth(
    health: RtcDataChannelHealth
): boolean {
    return health.readyState === 'open' || health.state === 'Open';
}

export function isClosedRtcChannelHealth(
    health: RtcDataChannelHealth
): boolean {
    return health.readyState === 'closing' ||
        health.readyState === 'closed' ||
        health.state === 'Closed' ||
        health.state === 'Failed';
}

export async function waitForRtcChannelOpenOrAbort(
    channel: QRtcDataChannel,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined
): Promise<boolean> {
    if (signal?.aborted) {
        throw toError(signal.reason);
    }
    const opened = await channel.waitUntilOpen(timeoutMs, signal);
    if (signal?.aborted) {
        throw toError(signal.reason);
    }
    return opened;
}
