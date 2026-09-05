import { describe, expect, it } from 'vitest';

import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { selectGroupDialPeerIds } from '@shared/services/webrtc-group-dial-policy.ts';

const groupRef: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'lobby' };
const localSessionId = 'session-local';

describe('selectGroupDialPeerIds', () => {
    // The discovery-holds-dials acceptance scenario: a presence-connected
    // `forming` lobby writes a bootstrap star as RTT evidence, and two
    // independent gates must each keep it from becoming a dial.
    it('dials nothing in a forming lobby holding a bootstrap star', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'forming',
            localSessionId,
            planned: createOverlay({ provenance: 'bootstrap', nextHopSessionIds: ['session-a', 'session-b'] }),
            accepted: undefined
        })).toEqual([]);
    });

    it('dials nothing in a forming lobby even when a server layout exists', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'forming',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-a'] }),
            accepted: undefined
        })).toEqual([]);
    });

    // The provenance gate alone, with the stage gate open: a bootstrap
    // overlay never substitutes for a missing server layout.
    it('refuses a bootstrap star as a substitute for the planned layout', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'connecting',
            localSessionId,
            planned: createOverlay({ provenance: 'bootstrap', nextHopSessionIds: ['session-a', 'session-b'] }),
            accepted: undefined
        })).toEqual([]);
    });

    it('dials the planned server layout while connecting', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'connecting',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-a', localSessionId, 'session-b'] }),
            accepted: undefined
        })).toEqual(['session-a', 'session-b']);
    });

    it('dials the accepted layout and not the planned one while active', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'active',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-planned'] }),
            accepted: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-accepted'] })
        })).toEqual(['session-accepted']);
    });

    it('dials both layouts once each while reconnecting', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'reconnecting',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-shared', 'session-planned'] }),
            accepted: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-shared', 'session-accepted'] })
        })).toEqual(['session-shared', 'session-accepted', 'session-planned']);
    });

    // A retired layout is a tombstone, not a peer set.
    it('refuses a removed server layout', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'active',
            localSessionId,
            planned: undefined,
            accepted: createOverlay({ provenance: 'server', state: 'removed', nextHopSessionIds: ['session-a'] })
        })).toEqual([]);
    });

    it('dials nothing when no layout is stored', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'active',
            localSessionId,
            planned: undefined,
            accepted: undefined
        })).toEqual([]);
    });
});

function createOverlay(
    overrides: Partial<OverlayInfo> & Pick<OverlayInfo, 'provenance' | 'nextHopSessionIds'>
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 2 },
        state: 'active',
        overlayId: 'app:workspace:lobby',
        groupRef,
        topology: 'star',
        name: 'Lobby',
        createdByClientId: 'creator',
        createdAtEpochMs: 1_000,
        degreeLimit: 8,
        overlayVersion: 1,
        updatedAtEpochMs: 1_000,
        ...overrides
    };
}
