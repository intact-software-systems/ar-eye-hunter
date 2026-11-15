import type { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';

/** Admits every new peer below the connection cap and refuses every one at it; every dial is allowed. */
export const UNGATED_RTC_BENCHMARK_PEER_ADMISSION: WebRtcConnectionService.PeerAdmission = {
    decideInbound: () => 'allow',
    decideInboundAtCap: () => 'deny',
    wouldAdmitInboundAtCap: () => false,
    decideOutbound: () => 'allow'
};
