import type { ServerTimeResponse } from '../api/api-config.ts';

const requestPrefix = 'rallar.clock.request.v1 ';
export const SOCKET_CLOCK_REPLY_PREFIX = 'rallar.clock.reply.v1 ';

export function socketClockRequest(nonce: string): string {
    return requestPrefix + nonce;
}

/** Connection-local control frames live outside the queued application-message namespace. */
export function replyToSocketClockRequest(data: string, peerId: string, now: () => number): string | undefined {
    if (data.length !== requestPrefix.length + 36 || !data.startsWith(requestPrefix)) {
        return undefined;
    }
    const nonce = data.slice(requestPrefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
        return undefined;
    }
    const reading: ServerTimeResponse = { serverPeerId: peerId, serverNowEpochMs: now() };
    return SOCKET_CLOCK_REPLY_PREFIX + nonce + ' ' + JSON.stringify(reading);
}
