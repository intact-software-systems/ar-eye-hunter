import {
    resolveALUpstreamPeerId,
    toALOverlayAdjacency,
    type ALOverlayAdjacency
} from '../al-contracts/resolve-al-owned-child-peer-ids.ts';
import { toAcceptedOverlayContext } from './compute-rtc-outbound-carrier-availability.ts';
import type { RtcOutboundObservation } from './read-rtc-outbound-observation.ts';

/** The accepted layout's adjacency seen from `selfPeerId`; absent when no layout is accepted or it carries none. */
export function toRtcAcceptedOverlayAdjacency(
    observation: RtcOutboundObservation,
    selfPeerId: string
): ALOverlayAdjacency | undefined {
    return toALOverlayAdjacency(selfPeerId, toAcceptedOverlayContext(observation)?.overlay.nextHopsBySessionId);
}

/** The one connected neighbour toward `originPeerId` in the accepted layout; none when that layout places none. */
export function resolveRtcUpstreamPeerId(
    observation: RtcOutboundObservation,
    selfPeerId: string,
    originPeerId: string
): string | undefined {
    return resolveALUpstreamPeerId(
        toRtcAcceptedOverlayAdjacency(observation, selfPeerId),
        originPeerId,
        observation.connectedPeerIds
    );
}
