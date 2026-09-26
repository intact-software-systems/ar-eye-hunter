import { describe, expect, it } from 'vitest';

import { resolveDefaultGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { computeNoRttTopologyNextHops } from '@shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts';
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

    it('keeps an incoming list with a repeated id verbatim and still appends to it', () => {
        expect(toRtcTransportVisitedPeerIds({
            visitedPeerIds: ['a', 'a', 'b'],
            selfPeerId: 'b',
            nextHopPeerIds: ['d']
        })).toEqual(['a', 'a', 'b', 'd']);
    });

    // One dispatch of the default topology never reaches the cap: the widest is a star just below the tree
    // size, or a tree or mesh at the degree limit. A path accumulates every dispatch along it, bounded only
    // by the room size; past the cap the newest siblings fall away and are relayed to redundantly, and the
    // duplicate re-ACK to every sender keeps every row completing.
    it.each(['star', 'tree', 'mesh'] as const)('never truncates the widest default %s dispatch', (topology) => {
        const config = resolveDefaultGroupTopologyConfig();
        const size = topology === 'star' ? config.treeMinSize - 1 : config.meshMinSize * 4;
        const sessionIds = Array.from({ length: size }, (_, index) => `session-${String(index).padStart(3, '0')}`);
        const nextHopsBySessionId = computeNoRttTopologyNextHops({
            topology,
            activeSessionIds: sessionIds,
            degreeLimit: config.degreeLimit,
            meshParamK: config.meshParamK
        });
        const widest = Math.max(
            ...Object.entries(nextHopsBySessionId).map(([selfPeerId, nextHopPeerIds]) =>
                toRtcTransportVisitedPeerIds({ visitedPeerIds: undefined, selfPeerId, nextHopPeerIds }).length
            )
        );

        expect(widest).toBe(1 + Math.max(...Object.values(nextHopsBySessionId).map((hops) => hops.length)));
        expect(widest).toBeLessThanOrEqual(AL_MESSAGE_RESOURCE_LIMITS.visitedPeers);
    });
});
