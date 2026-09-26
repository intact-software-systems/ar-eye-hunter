import { describe, expect, it } from 'vitest';

import { resolveDefaultGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toRtcTransportVisitedPeerIds } from '@shared/multicast/to-rtc-transport-visited-peer-ids.ts';

describe('toRtcTransportVisitedPeerIds', () => {
    it('extends the visited set with the sender and every next hop of the dispatch, once each', () => {
        expect(toRtcTransportVisitedPeerIds({
            visitedPeerIds: ['origin', 'relay'],
            selfPeerId: 'relay',
            nextHopPeerIds: ['b', 'c', 'origin']
        })).toEqual(['origin', 'relay', 'b', 'c']);
    });

    it('keeps the visited set as a prefix and drops the newest entries past the cap', () => {
        const visitedPeerIds = Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.visitedPeers - 1 }, (_, index) => `p-${index}`);

        expect(toRtcTransportVisitedPeerIds({ visitedPeerIds, selfPeerId: 'self', nextHopPeerIds: ['b'] }))
            .toEqual([...visitedPeerIds, 'self']);
    });

    // The cap must never truncate one dispatch: the widest dispatch set of the default topology is a star
    // just below the tree size (every other session a hop) or a tree/mesh at its degree limit, plus the sender.
    it('never truncates the dispatch set of the default topology', () => {
        const config = resolveDefaultGroupTopologyConfig();
        const widestStarHops = config.treeMinSize - 2;
        const widestDispatch = 1 + Math.max(widestStarHops, config.degreeLimit);

        expect(widestDispatch).toBeLessThanOrEqual(AL_MESSAGE_RESOURCE_LIMITS.visitedPeers);
    });
});
