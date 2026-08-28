import { describe, expect, it } from 'vitest';

import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { toDeliverableTopologySnapshot } from '@shared-server/rallar-system/topology/replay/deliverable-topology-snapshot.ts';

function snapshot(
    state: 'active' | 'removed',
    activeSessionIds: readonly string[]
): RallarOverlayTopologySnapshot {
    return { state, activeSessionIds } as RallarOverlayTopologySnapshot;
}

describe('toDeliverableTopologySnapshot', () => {
    it('prefers the accepted layout whenever a promotion produced one', () => {
        const planned = snapshot('active', ['a', 'b']);
        const accepted = snapshot('active', ['a']);
        expect(toDeliverableTopologySnapshot({ planned, accepted })).toBe(accepted);
        expect(toDeliverableTopologySnapshot({ planned, accepted: undefined })).toBe(planned);
        expect(toDeliverableTopologySnapshot({ planned: undefined, accepted })).toBe(accepted);
        expect(toDeliverableTopologySnapshot({ planned: undefined, accepted: undefined })).toBeUndefined();
    });

    it('lets a planned removal tombstone win: teardown is never shadowed by the stale accepted row', () => {
        const tombstone = snapshot('removed', ['a', 'b']);
        const accepted = snapshot('active', ['a', 'b']);
        expect(toDeliverableTopologySnapshot({ planned: tombstone, accepted })).toBe(tombstone);
        expect(
            toDeliverableTopologySnapshot({ planned: tombstone, accepted, sessionId: 'a' })
        ).toBe(tombstone);
    });

    it('serves a member named only in the held planned candidate their candidate assignment', () => {
        const planned = snapshot('active', ['a', 'newcomer']);
        const accepted = snapshot('active', ['a']);
        expect(
            toDeliverableTopologySnapshot({ planned, accepted, sessionId: 'newcomer' })
        ).toBe(planned);
        expect(toDeliverableTopologySnapshot({ planned, accepted, sessionId: 'a' })).toBe(accepted);
        // A member neither row names still resolves the traffic layout; the
        // caller's own membership guard answers no-topology.
        expect(toDeliverableTopologySnapshot({ planned, accepted, sessionId: 'ghost' })).toBe(accepted);
    });
});
