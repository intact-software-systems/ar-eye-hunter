// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/persistence/rtc-topology-errors.ts';
import {
    computeRtcTopologyInputFingerprint,
    computeRtcTopologyInputFingerprintRow,
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
    RtcTopologyInputFingerprintRepository,
    validateRtcTopologyInputFingerprintRow,
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
const EFFECTIVE_CONFIG: EffectiveGroupTopologyConfig = {
    topologyKind: 'auto',
    degreeLimit: 4,
    treeMinSize: 3,
    meshMinSize: 2,
    meshParamK: 2
};

describe('RTC topology input fingerprint persistence', () => {
    it.each([
        '2026-01-01T00:00:00.000Z',
        '9999-12-31T23:59:59.998Z',
        'not-a-timestamp'
    ])('rejects altered fingerprint expiry %s before writing', (expireAtIsoTimestamp) => {
        const computed = computeRtcTopologyInputFingerprintRow(GROUP_REF, FINGERPRINT);
        expect(validateRtcTopologyInputFingerprintRow(GROUP_REF, FINGERPRINT, computed)).toEqual([]);

        const altered = { ...computed, expireAtIsoTimestamp };
        expect(validateRtcTopologyInputFingerprintRow(GROUP_REF, FINGERPRINT, altered)).not.toEqual([]);
    });

    it('validates the exact computed fingerprint key and persisted bytes before writing', () => {
        const computed = computeRtcTopologyInputFingerprintRow(GROUP_REF, FINGERPRINT);
        expect(validateRtcTopologyInputFingerprintRow(GROUP_REF, FINGERPRINT, computed)).toEqual([]);
        for (
            const changed of [
                { ...computed, key: groupStateGroupStorageKey({ ...GROUP_REF, groupId: 'another-room' }) },
                { ...computed, value: JSON.stringify({ groupRef: GROUP_REF, fingerprint: `sha256:${'b'.repeat(64)}` }) },
                { ...computed, value: JSON.stringify({ groupRef: GROUP_REF, fingerprint: FINGERPRINT, extra: true }) }
            ]
        ) {
            expect(validateRtcTopologyInputFingerprintRow(GROUP_REF, FINGERPRINT, changed).length)
                .toBeGreaterThan(0);
        }
    });

    it('reads the exact current fingerprint row', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyInputFingerprintRepository(runtime);
        await runtime.upsert(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            groupStateGroupStorageKey(GROUP_REF),
            JSON.stringify({ groupRef: GROUP_REF, fingerprint: FINGERPRINT }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

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

    it('rejects an invalid input fingerprint during computation', () => {
        expect(() => computeRtcTopologyInputFingerprintRow(GROUP_REF, 'not-a-digest')).toThrow(
            'RTC topology input fingerprint is invalid'
        );
    });
});

describe('RTC topology input fingerprint inputs', () => {
    // A transport pause changes the group revision but not the planning inputs,
    // so it must preserve change suppression and the stored connection fence.
    it('is unchanged by a transport halt and its snapshot version bump', async () => {
        const flowing = await computeRtcTopologyInputFingerprint(
            createFingerprintFacts({ transportState: 'flowing', snapshotVersion: 4 })
        );
        const halted = await computeRtcTopologyInputFingerprint(
            createFingerprintFacts({ transportState: 'halted', snapshotVersion: 5 })
        );

        expect(halted).toBe(flowing);
    });

    it('changes when a planning input changes', async () => {
        const narrow = await computeRtcTopologyInputFingerprint(createFingerprintFacts({}));
        const wide = await computeRtcTopologyInputFingerprint({
            ...createFingerprintFacts({}),
            effectiveConfig: { ...EFFECTIVE_CONFIG, degreeLimit: EFFECTIVE_CONFIG.degreeLimit + 1 }
        });

        expect(wide).not.toBe(narrow);
    });
});

function createFingerprintFacts(groupOverrides: Partial<Group>): RtcTopologyInputFingerprintFacts {
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
