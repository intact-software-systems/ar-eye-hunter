import type { RtcDataChannelHealth } from '../webrtc/qrtc-data-channel.ts';

/**
 * Whether no ready next hop of a message can take it now: there is at least one, and every one's channel holds
 * at or above its high watermark (D184). A message with no ready next hop is not backpressured; it has no route.
 */
export function computeRtcBackpressure(
    channelsOfReadyNextHops: readonly Pick<RtcDataChannelHealth, 'bufferedAmount' | 'flowControl'>[]
): boolean {
    return channelsOfReadyNextHops.length > 0 &&
        channelsOfReadyNextHops.every((health) => health.bufferedAmount >= health.flowControl.highWatermarkBytes);
}
