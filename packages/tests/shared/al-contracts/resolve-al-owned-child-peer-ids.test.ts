import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { resolveALOwnedChildPeerIds } from '@shared/al-contracts/resolve-al-owned-child-peer-ids.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

/** `r` is the root; `a`, `b` and `c` each lead to one leaf. */
const TREE: Readonly<Record<string, readonly string[]>> = {
    r: ['a', 'b', 'c'],
    a: ['r', 'a1'],
    a1: ['a'],
    b: ['r', 'b1'],
    b1: ['b'],
    c: ['r', 'c1'],
    c1: ['c']
};

describe('the children a peer owns for a multicast frozen to its recipients', () => {
    it('keeps only the child whose subtree holds a recipient', () => {
        expect(resolveRelayChildren(['b1'])).toEqual(['b']);
    });

    it('keeps none when this peer is the only recipient, since nothing below it is one', () => {
        expect(resolveRelayChildren(['r'])).toEqual([]);
    });

    it('keeps none for an audience frozen to nobody, with or without an accepted layout', () => {
        expect(resolveRelayChildren([])).toEqual([]);
        expect(resolveALOwnedChildPeerIds(createFrozenMulticast([]), {
            nowMs: 0,
            selfPeerId: 'r',
            overlayNeighborPeerIds: TREE.r
        })).toEqual([]);
    });

    it('keeps every child when it is no recipient and its layout puts every recipient behind its sender', () => {
        expect(resolveRelayChildren(['a1'])).toEqual(['b', 'c']);
    });

    it('keeps every child when the layout does not place one of the recipients', () => {
        expect(resolveRelayChildren(['b1', 'unplaced'])).toEqual(['b', 'c']);
    });

    it('keeps every child when its room lags the path child, and the relay below it then keeps every child too', () => {
        const message = createFrozenMulticast(['b1']);

        const lagging = resolveALOwnedChildPeerIds(message, {
            nowMs: 0,
            selfPeerId: 'r',
            fromPeerId: 'a',
            groupMemberPeerIds: ['r', 'a', 'c', 'c1', 'b1'],
            overlayNeighborPeerIds: TREE.r,
            overlayNextHopsBySessionId: TREE
        });
        const below = resolveALOwnedChildPeerIds(message, {
            nowMs: 0,
            selfPeerId: 'c',
            fromPeerId: 'r',
            overlayNeighborPeerIds: TREE.c,
            overlayNextHopsBySessionId: TREE
        });

        expect(lagging).toEqual(['c']);
        expect(below).toEqual(['c1']);
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

describe('the children a peer owns while a replaced layout is in force', () => {
    /** The layout `TREE` replaced: `r` led to `a1` and `b1`, and `c` hung below `a1` through `c1`. */
    const REPLACED_TREE: Readonly<Record<string, readonly string[]>> = {
        r: ['a1', 'b1'],
        a1: ['r', 'c1'],
        c1: ['a1', 'c'],
        c: ['c1'],
        b1: ['r', 'b', 'a'],
        b: ['b1'],
        a: ['b1']
    };

    it('owns the replaced layout\'s children beside the accepted layout\'s', () => {
        const message = newALMulticastMessage('origin', { topicId: 'chat', resourceId: 'shot', contextId: 'room' }, ROOM, 'chat.v1', {});

        expect(resolveALOwnedChildPeerIds(message, {
            nowMs: 0,
            selfPeerId: 'r',
            fromPeerId: 'a',
            overlayNeighborPeerIds: TREE.r,
            overlayNextHopsBySessionId: TREE,
            previousOverlayLayout: { neighborPeerIds: REPLACED_TREE.r!, nextHopsBySessionId: REPLACED_TREE }
        })).toEqual(['b', 'c', 'a1', 'b1']);
        // `b` is a neighbour in both layouts and is owned once, so one dispatch sends it one copy.
        expect(resolveALOwnedChildPeerIds(message, {
            nowMs: 0,
            selfPeerId: 'r',
            overlayNeighborPeerIds: ['b'],
            previousOverlayLayout: { neighborPeerIds: ['b', 'x'], nextHopsBySessionId: undefined }
        })).toEqual(['b', 'x']);
    });

    it('prunes a frozen multicast toward its recipients over each layout\'s own adjacency', () => {
        // Over the accepted tree only `c` leads to `c`; over the replaced tree only `a1` does. Pruning the replaced
        // layout's children over the accepted adjacency would find no path and keep both `a1` and `b1`.
        expect(resolveALOwnedChildPeerIds(createFrozenMulticast(['c']), {
            nowMs: 0,
            selfPeerId: 'r',
            overlayNeighborPeerIds: TREE.r,
            overlayNextHopsBySessionId: TREE,
            previousOverlayLayout: { neighborPeerIds: REPLACED_TREE.r!, nextHopsBySessionId: REPLACED_TREE }
        })).toEqual(['c', 'a1']);
    });

    describe('when the path child toward the recipient is already visited', () => {
        /** `a` sent `c` a copy over the accepted edge and `b` one over the replaced edge; `e`, `f` hold no recipient. */
        const ACCEPTED = { a: ['c'], b: ['c', 'e'], c: ['a', 'b'], e: ['b', 'f'], f: ['e'] };
        const REPLACED = { a: ['b'], b: ['a', 'c', 'e'], c: ['b'], e: ['b', 'f'], f: ['e'] };
        const COPY_TO_B = { ...createFrozenMulticast(['c']), diagnostics: { visitedPeerIds: ['a', 'c', 'b'] } };

        it('owns nothing over either layout while the replaced one is in force', () => {
            expect(resolveALOwnedChildPeerIds(COPY_TO_B, {
                nowMs: 0,
                selfPeerId: 'b',
                fromPeerId: 'a',
                overlayNeighborPeerIds: ACCEPTED.b,
                overlayNextHopsBySessionId: ACCEPTED,
                previousOverlayLayout: { neighborPeerIds: REPLACED.b, nextHopsBySessionId: REPLACED }
            })).toEqual([]);
        });

        // Green on first run.
        it('keeps every neighbour with one layout in force, as before the overlap', () => {
            expect(resolveALOwnedChildPeerIds(COPY_TO_B, {
                nowMs: 0,
                selfPeerId: 'b',
                fromPeerId: 'a',
                overlayNeighborPeerIds: ACCEPTED.b,
                overlayNextHopsBySessionId: ACCEPTED
            })).toEqual(['e']);
        });

        // Green on first run.
        it('keeps a neighbour that reaches the recipient only over the other layout\'s edges', () => {
            // `b` failed and is named visited; `d` is a neighbour over the replaced layout only, and reaches `c`
            // through `g` over the accepted one.
            const accepted = { a: ['b'], b: ['a', 'g'], c: ['g'], d: ['g'], g: ['b', 'c', 'd'] };
            const replaced = { a: ['b', 'd'], b: ['a', 'c'], c: ['b'], d: ['a', 'g'], g: ['d'] };

            expect(resolveALOwnedChildPeerIds({ ...createFrozenMulticast(['c']), diagnostics: { visitedPeerIds: ['b'] } }, {
                nowMs: 0,
                selfPeerId: 'a',
                overlayNeighborPeerIds: accepted.a,
                overlayNextHopsBySessionId: accepted,
                previousOverlayLayout: { neighborPeerIds: replaced.a, nextHopsBySessionId: replaced }
            })).toEqual(['d']);
        });

        // Green on first run.
        it('keeps every neighbour while the replaced one is in force when the recipient is behind its sender', () => {
            expect(resolveALOwnedChildPeerIds(createFrozenMulticast(['a1']), {
                nowMs: 0,
                selfPeerId: 'r',
                fromPeerId: 'a',
                overlayNeighborPeerIds: TREE.r,
                overlayNextHopsBySessionId: TREE,
                previousOverlayLayout: { neighborPeerIds: ['b'], nextHopsBySessionId: TREE }
            })).toEqual(['b', 'c']);
        });
    });

    it('owns only the accepted layout\'s children when no replaced layout is given', () => {
        const message = newALMulticastMessage('origin', { topicId: 'chat', resourceId: 'shot', contextId: 'room' }, ROOM, 'chat.v1', {});

        expect(resolveALOwnedChildPeerIds(message, {
            nowMs: 0,
            selfPeerId: 'r',
            fromPeerId: 'a',
            overlayNeighborPeerIds: TREE.r,
            overlayNextHopsBySessionId: TREE
        })).toEqual(['b', 'c']);
    });
});

describe('the child a peer owns for a unicast', () => {
    it('keeps the unicast\'s immediate peer, whatever the frozen audience rule', () => {
        const unicast = newALUnicastMessage('origin', { topicId: 'chat', resourceId: 'shot', contextId: 'room' }, 'b', 'chat.v1', {});

        expect(resolveALOwnedChildPeerIds(unicast, { nowMs: 0, selfPeerId: 'r', overlayNeighborPeerIds: TREE.r })).toEqual(['b']);
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
