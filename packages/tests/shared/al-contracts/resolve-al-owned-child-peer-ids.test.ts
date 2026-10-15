import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { resolveALOwnedChildPeerIds } from '@shared/al-contracts/resolve-al-owned-child-peer-ids.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

/** `r` is the root; `a` and `b` each lead to one leaf, `c` is a leaf itself. */
const TREE: Readonly<Record<string, readonly string[]>> = {
    r: ['a', 'b', 'c'],
    a: ['r', 'a1'],
    a1: ['a'],
    b: ['r', 'b1'],
    b1: ['b'],
    c: ['r']
};

describe('the children a peer owns for a multicast frozen to its recipients', () => {
    it('keeps only the child whose subtree holds a recipient', () => {
        expect(resolveRelayChildren(['b1'])).toEqual(['b']);
    });

    it('keeps none when this peer is the only recipient, since nothing below it is one', () => {
        expect(resolveRelayChildren(['r'])).toEqual([]);
    });

    it('keeps every child when it is no recipient and its layout puts every recipient behind its sender', () => {
        expect(resolveRelayChildren(['a1'])).toEqual(['b', 'c']);
    });

    it('keeps every child when the layout does not place one of the recipients', () => {
        expect(resolveRelayChildren(['b1', 'unplaced'])).toEqual(['b', 'c']);
    });

    it('keeps every child without an accepted layout', () => {
        expect(resolveALOwnedChildPeerIds(createFrozenMulticast(['b1']), {
            nowMs: 0,
            selfPeerId: 'r',
            fromPeerId: 'a',
            overlayNeighborPeerIds: TREE.r
        })).toEqual(['b', 'c']);
    });

    it('ends its walk over a cyclic layout and keeps the child that reaches a recipient only through a sibling', () => {
        const cyclic = { r: ['a', 'b'], a: ['r', 'b'], b: ['r', 'a', 'x'], x: ['b'] };

        expect(resolveALOwnedChildPeerIds(createFrozenMulticast(['x']), {
            nowMs: 0,
            selfPeerId: 'r',
            overlayNeighborPeerIds: cyclic.r,
            overlayNextHopsBySessionId: cyclic
        })).toEqual(['a', 'b']);
    });
});

/** The children of `r` for a copy relayed from `a` over the accepted tree. */
function resolveRelayChildren(recipientPeerIds: readonly string[]): readonly string[] {
    return resolveALOwnedChildPeerIds(createFrozenMulticast(recipientPeerIds), {
        nowMs: 0,
        selfPeerId: 'r',
        fromPeerId: 'a',
        overlayNeighborPeerIds: TREE.r,
        overlayNextHopsBySessionId: TREE
    });
}

function createFrozenMulticast(recipientPeerIds: readonly string[]): ALMessage {
    const message = newALMulticastMessage('origin', { topicId: 'chat', resourceId: 'shot', contextId: 'room' }, ROOM, 'chat.v1', {});
    return toALFrozenMulticastMessage(message, { recipientPeerIds, snapshotVersion: 1 });
}
