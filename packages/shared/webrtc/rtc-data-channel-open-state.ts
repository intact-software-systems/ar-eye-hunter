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
    const waitUntilOpen = timeoutMs === undefined
        ? channel.waitUntilOpen()
        : channel.waitUntilOpen(timeoutMs);

    if (!signal) {
        return await waitUntilOpen;
    }

    if (signal.aborted) {
        throw toError(signal.reason);
    }

    return await new Promise<boolean>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(toError(signal.reason));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        waitUntilOpen
            .then((opened) => {
                signal.removeEventListener('abort', onAbort);
                resolve(opened);
            })
            .catch((caught) => {
                const error = toError(caught);
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
    });
}
