import { toALRuntimeStoreId, type ALRuntimeStoreId } from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';

/**
 * The checkpoint lanes' own store ids: their rows never share a key prefix, a work namespace or a canonical
 * scope with the durable lanes', so the durable lane's bootstrap, recovery and waits never read them.
 */
export function toBrowserWsClientALCheckpointRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-ws-client-checkpoint:${sessionId}`);
}

export function toBrowserRtcOverlayALCheckpointRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-rtc-overlay-checkpoint:${sessionId}`);
}
