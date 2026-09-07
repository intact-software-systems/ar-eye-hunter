import { describe, expect, it } from 'vitest';

import {
    GROUP_CONNECT_REJECTION_CODES,
    isGroupConnectRejectionCode
} from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import { isGroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import { toOverlayLayoutIdentity } from '@shared/repository/overlays-repository.ts';

describe('group connect rejection codes', () => {
    it('names exactly the three connect conflicts: the stale epoch and the two layouts of product decision 32', () => {
        expect([...GROUP_CONNECT_REJECTION_CODES]).toEqual([
            'group-connect-stale-epoch',
            'group-connect-no-planned-layout',
            'group-connect-planned-layout-superseded'
        ]);
        expect(isGroupConnectRejectionCode('group-connect-stale-epoch')).toBe(true);
        expect(isGroupConnectRejectionCode('group-connect-no-planned-layout')).toBe(true);
        expect(isGroupConnectRejectionCode('lifecycle-transition-invalid')).toBe(false);
    });

    it('classifies policy reason codes without string matching', () => {
        expect(isGroupPolicyReasonCode('lifecycle-transition-invalid')).toBe(true);
        expect(isGroupPolicyReasonCode('group-connect-no-planned-layout')).toBe(false);
    });

    it('reads a layout identity off an overlay info', () => {
        expect(
            toOverlayLayoutIdentity({
                sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 2 },
                provenance: 'server',
                state: 'active',
                overlayId: 'app-1/workspace-1/room-1',
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                topology: 'tree',
                name: 'room-1',
                createdByClientId: 'server',
                createdAtEpochMs: 1,
                nextHopSessionIds: [],
                degreeLimit: 2,
                overlayVersion: 7,
                updatedAtEpochMs: 1
            })
        ).toEqual({ groupRevision: 4, presenceRevision: 2, version: 7, state: 'active' });
    });
});
