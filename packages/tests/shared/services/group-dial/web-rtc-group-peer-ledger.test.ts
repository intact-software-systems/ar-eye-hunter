import { describe, expect, it } from 'vitest';

import type { ClientInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcGroupPeerLedger } from '@shared/services/group-dial/web-rtc-group-peer-ledger.ts';

describe('WebRtcGroupPeerLedger', () => {
    it('retains an undesired known peer with a negative overlay transition grace as if the grace were 0', () => {
        const ledger = new WebRtcGroupPeerLedger({
            localSessionId: 'session-local',
            repositories: {
                groupCache: new LatestRepository<string, GroupSnapshot>(),
                clientCache: new LatestRepository<string, ClientInfo>()
            },
            maxPeerConnections: 10,
            overlayTransitionGraceMs: -5_000,
            nowEpochMs: () => 1_000
        });

        ledger.retainedPeers.retainUndesiredKnownPeers(new Set(), new Set(['session-a']));

        expect(ledger.retainedPeers.getRetainedPeerConnections().get('session-a')?.expiresAtEpochMs).toBe(1_000);
    });
});
