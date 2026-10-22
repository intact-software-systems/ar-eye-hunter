import { describe, expect, it } from 'vitest';

import {
    resolveRttReplanPromotion,
    type ResolveRttReplanPromotionInput
} from '@shared-server/rallar-system/topology/planning/resolve-rtt-replan-promotion.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

const ACCEPTED_AT_EPOCH_MS = 2_000;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

describe('RTT replan promotion', () => {
    it('promotes a young layout at once when no input fingerprint was recorded for it', () => {
        expect(resolveRttReplanPromotion({ ...youngReplan(), storedInputFingerprint: null })).toEqual({
            decision: 'promote',
            reason: 'topology-inputs-changed',
            layoutAgeMs: 500
        });
    });

    it('promotes a young layout at once when presence advanced past it', () => {
        expect(resolveRttReplanPromotion({ ...youngReplan(), presenceRevision: 1 })).toEqual({
            decision: 'promote',
            reason: 'presence-advanced',
            layoutAgeMs: 500
        });
    });

    it('holds a young layout whose inputs and presence the replan leaves unchanged', () => {
        expect(resolveRttReplanPromotion(youngReplan())).toEqual({
            decision: 'hold',
            reason: 'layout-younger-than-minimum-age',
            layoutAgeMs: 500
        });
    });

    it('promotes once the layout has stood for exactly the minimum age', () => {
        expect(resolveRttReplanPromotion({ ...youngReplan(), nowEpochMs: ACCEPTED_AT_EPOCH_MS + 15_000 })).toEqual({
            decision: 'promote',
            reason: 'layout-at-minimum-age',
            layoutAgeMs: 15_000
        });
    });

    it('promotes every RTT replan at once when the minimum age is zero', () => {
        expect(resolveRttReplanPromotion({ ...youngReplan(), rttReplanMinimumLayoutAgeMs: 0 })).toEqual({
            decision: 'promote',
            reason: 'layout-at-minimum-age',
            layoutAgeMs: 500
        });
    });
});

function youngReplan(): ResolveRttReplanPromotionInput {
    return {
        stored: storedLayout(),
        storedInputFingerprint: FINGERPRINT,
        inputFingerprint: FINGERPRINT,
        presenceRevision: 0,
        rttReplanMinimumLayoutAgeMs: 15_000,
        nowEpochMs: ACCEPTED_AT_EPOCH_MS + 500
    };
}

function storedLayout(): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 0 },
        state: 'active',
        overlayId: 'app-1:workspace-1:group-1',
        groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
        name: 'group-1',
        topology: 'tree',
        activeSessionIds: ['peer-1', 'peer-2'],
        nextHopsBySessionId: { 'peer-1': ['peer-2'], 'peer-2': ['peer-1'] },
        degreeLimit: 5,
        version: 1,
        createdByClientId: 'peer-1',
        createdAtEpochMs: 1,
        updatedAtEpochMs: ACCEPTED_AT_EPOCH_MS
    };
}
