import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/persistence/rtc-topology-errors.ts';
import {
    computeRtcTopologyInputFingerprint,
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
    RtcTopologyInputFingerprintRepository,
    type RtcTopologyInputFingerprintFacts
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import type { Group } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createTestGroup } from '../../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const GROUP_REF = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
} as const;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

describe('RTC topology input fingerprint persistence', () => {
    it('round-trips the exact current fingerprint row', async () => {
        const repository = new RtcTopologyInputFingerprintRepository(
            new FakeRuntimeStateRepository()
        );

        await repository.putFingerprint(GROUP_REF, FINGERPRINT);

        await expect(repository.findFingerprint(GROUP_REF)).resolves.toBe(FINGERPRINT);
    });

    it.each([
        {
            label: 'an extra field',
            value: { groupRef: GROUP_REF, fingerprint: FINGERPRINT, unexpected: true }
        },
        {
            label: 'a foreign group identity',
            value: {
                groupRef: { ...GROUP_REF, groupId: 'another-room' },
                fingerprint: FINGERPRINT
            }
        },
        {
            label: 'an invalid digest',
            value: { groupRef: GROUP_REF, fingerprint: 'not-a-digest' }
        }
    ])('rejects $label at the current fingerprint corruption boundary', async ({ value }) => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyInputFingerprintRepository(runtime);
        const key = groupStateGroupStorageKey(GROUP_REF);
        await runtime.upsert(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            key,
            JSON.stringify(value),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findFingerprint(GROUP_REF)).rejects.toBeInstanceOf(
            RtcTopologyRepositoryInvariantCorruptionError
        );
        await expect(
            runtime.findEntry(RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE, key)
        ).resolves.toBeDefined();
    });

    it('rejects malformed stored JSON at the current fingerprint corruption boundary', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyInputFingerprintRepository(runtime);
        const key = groupStateGroupStorageKey(GROUP_REF);
        await runtime.upsert(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            key,
            '{',
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findFingerprint(GROUP_REF)).rejects.toBeInstanceOf(
            RtcTopologyRepositoryInvariantCorruptionError
        );
    });

    it('rejects an invalid fingerprint before writing', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyInputFingerprintRepository(runtime);

        await expect(repository.putFingerprint(GROUP_REF, 'not-a-digest')).rejects.toThrow(
            'RTC topology input fingerprint is invalid'
        );
        await expect(
            runtime.findAllEntries(RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE)
        ).resolves.toEqual([]);
    });
});

describe('RTC topology input fingerprint inputs', () => {
    // The valve bumps the group's snapshot version, which the planner would
    // otherwise read as a fresh authority. The digest hashes the planning
    // inputs alone, so a pause leaves change suppression latched and an
    // outstanding connect fence still names the stored plan (decision 25).
    it('is unchanged by a transport halt and its snapshot version bump', async () => {
        const flowing = await computeRtcTopologyInputFingerprint(
            fingerprintFacts({ transportState: 'flowing', snapshotVersion: 4 })
        );
        const halted = await computeRtcTopologyInputFingerprint(
            fingerprintFacts({ transportState: 'halted', snapshotVersion: 5 })
        );

        expect(halted).toBe(flowing);
    });

    it('changes when a planning input changes', async () => {
        const narrow = await computeRtcTopologyInputFingerprint(fingerprintFacts({}));
        const wide = await computeRtcTopologyInputFingerprint({
            ...fingerprintFacts({}),
            effectiveConfig: { ...EFFECTIVE_CONFIG, degreeLimit: EFFECTIVE_CONFIG.degreeLimit + 1 }
        });

        expect(wide).not.toBe(narrow);
    });
});

const EFFECTIVE_CONFIG: EffectiveGroupTopologyConfig = {
    topologyKind: 'auto',
    degreeLimit: 4,
    treeMinSize: 3,
    meshMinSize: 2,
    meshParamK: 2
};

function fingerprintFacts(groupOverrides: Partial<Group>): RtcTopologyInputFingerprintFacts {
    return {
        group: {
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            group: createTestGroup({ ...GROUP_REF, ...groupOverrides }),
            members: [],
            activeSessions: [],
            memberCount: 0,
            onlineMemberCount: 0
        },
        effectiveConfig: EFFECTIVE_CONFIG,
        kindHysteresisWidths: { meshExitWidth: 1, treeExitWidth: 1 }
    };
}
