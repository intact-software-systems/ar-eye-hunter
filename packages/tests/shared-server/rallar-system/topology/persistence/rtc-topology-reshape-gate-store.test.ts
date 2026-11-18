import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/persistence/rtc-topology-errors.ts';
import {
    computeRtcTopologyReshapeGateWrite,
    decodeStoredTopologyReshapeGate
} from '@shared-server/rallar-system/topology/persistence/rtc-topology-reshape-gate-store.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

const GROUP_REF: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

const HELD_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: 10_000, consecutiveHeldPasses: 1, heldAtEpochMs: 12_000 },
    wantedReasons: ['kind-change', 'leader-rooting']
};

describe('RTC topology reshape gate store', () => {
    it('a gate write is keyed by the room, never expires, and its value decodes back to the state', () => {
        const write = computeRtcTopologyReshapeGateWrite(GROUP_REF, HELD_STATE, 4);

        expect(write).toMatchObject({
            key: groupStateGroupStorageKey(GROUP_REF),
            expectedRevision: 4,
            expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString()
        });
        expect(decodeStoredTopologyReshapeGate(write.key, write.value)).toEqual(HELD_STATE);
    });

    it('a first gate write inserts where no row is stored', () => {
        expect(computeRtcTopologyReshapeGateWrite(GROUP_REF, HELD_STATE, null).expectedRevision).toBeNull();
    });

    it('a stored value naming another room is corruption', () => {
        const other = computeRtcTopologyReshapeGateWrite({ ...GROUP_REF, groupId: 'room-2' }, HELD_STATE, null);

        expect(() => decodeStoredTopologyReshapeGate(groupStateGroupStorageKey(GROUP_REF), other.value))
            .toThrow(RtcTopologyRepositoryInvariantCorruptionError);
    });

    it('a stored value whose state does not decode is corruption', () => {
        const key = groupStateGroupStorageKey(GROUP_REF);
        const badState = JSON.stringify({
            groupRef: GROUP_REF,
            state: { ...HELD_STATE, wantedReasons: ['delta-too-large'] }
        });

        expect(() => decodeStoredTopologyReshapeGate(key, badState)).toThrow(RtcTopologyRepositoryInvariantCorruptionError);
        expect(() => decodeStoredTopologyReshapeGate(key, '{')).toThrow(RtcTopologyRepositoryInvariantCorruptionError);
        expect(() => decodeStoredTopologyReshapeGate(key, JSON.stringify({ groupRef: GROUP_REF })))
            .toThrow(RtcTopologyRepositoryInvariantCorruptionError);
    });
});
