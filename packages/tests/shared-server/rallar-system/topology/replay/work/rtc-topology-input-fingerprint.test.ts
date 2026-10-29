import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/topology/persistence/rtc-topology-errors.ts';
import {
    computeRtcTopologyInputFingerprint,
    computeRtcTopologyInputFingerprintWrite,
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
    RtcTopologyInputFingerprintRepository,
    type RtcTopologyInputFingerprintFacts
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import type { EffectiveGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import type { Group, GroupSnapshot } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createTestGroup } from '../../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { GroupBarrierRepository } from '../../../group-state/group-state-concurrency-test-runtime.ts';
import {
    applyPublicationMutation,
    GRANT_ROOM,
    seedGrantRoom
} from '../../../group-state/mutation/group-publication-grant-test-runtime.ts';
import { requireSnapshot } from '../../../group-state/presence/group-presence-test-runtime.ts';
import { createRtcTopologyGroupSnapshot, toRtcTopologyGroupWithDirector } from '../../rtc-topology-test-fixtures.ts';

const GROUP_REF = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
} as const;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

describe('RTC topology input fingerprint persistence', () => {
    it('reads back the exact fingerprint row the work transaction writes', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyInputFingerprintRepository(runtime);
        const write = computeRtcTopologyInputFingerprintWrite(GROUP_REF, FINGERPRINT);
        await runtime.upsert(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            write.key,
            write.value,
            Date.parse(write.expireAtIsoTimestamp)
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

    it('rejects an invalid fingerprint before computing its write', () => {
        expect(() => computeRtcTopologyInputFingerprintWrite(GROUP_REF, 'not-a-digest')).toThrow(
            'RTC topology input fingerprint is invalid'
        );
    });
});

describe('RTC topology input fingerprint inputs', () => {
    // The valve bumps the group's snapshot version, which the planner would
    // otherwise read as a fresh authority. The digest hashes the planning
    // inputs alone, so a pause leaves change suppression latched and an
    // outstanding connect fence still names the stored plan (decision 25).
    it('is unchanged by a transport halt and its snapshot version bump', () => {
        const flowing = computeRtcTopologyInputFingerprint(
            fingerprintFacts({ transportState: 'flowing', snapshotVersion: 4 })
        );
        const halted = computeRtcTopologyInputFingerprint(
            fingerprintFacts({ transportState: 'halted', snapshotVersion: 5 })
        );

        expect(halted).toBe(flowing);
    });

    // D493: a grant write enqueues presence-summary work, so the planner sees a
    // fresh snapshot version; grants are no planning input, so that work is a no-op.
    it('a grant-only write leaves the topology input fingerprint unchanged', async () => {
        const runtime = new GroupBarrierRepository();
        await seedGrantRoom(runtime);
        const before = await requireSnapshot(runtime, GRANT_ROOM);
        await applyPublicationMutation(runtime, {
            operation: 'grantGroupPublication',
            actorPrincipalId: 'alice',
            targetPrincipalId: 'bob',
            topicId: 'room.feed',
            publish: true,
            subscribe: true,
            requestId: 'grant-bob-feed'
        });
        const after = await requireSnapshot(runtime, GRANT_ROOM);

        expect(after.group.snapshotVersion).toBe(before.group.snapshotVersion + 1);
        expect(computeRtcTopologyInputFingerprint({ ...fingerprintFacts({}), group: after })).toBe(
            computeRtcTopologyInputFingerprint({ ...fingerprintFacts({}), group: before })
        );
    });

    it('changes when a planning input changes', () => {
        const narrow = computeRtcTopologyInputFingerprint(fingerprintFacts({}));
        const wide = computeRtcTopologyInputFingerprint({
            ...fingerprintFacts({}),
            effectiveConfig: { ...EFFECTIVE_CONFIG, degreeLimit: EFFECTIVE_CONFIG.degreeLimit + 1 }
        });

        expect(wide).not.toBe(narrow);
    });

    it('keeps the digest a leaderless group stored before directors moved the fingerprint', () => {
        expect(computeRtcTopologyInputFingerprint(fingerprintFacts({}))).toBe(
            'sha256:7a299894c9bbd72d36d512270cc5aabe4ebe3fd619aef70e4f9a35a314fa9ae2'
        );
    });

    it('changes when the present appointed director changes', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
        const fingerprintOf = (snapshot: GroupSnapshot) => computeRtcTopologyInputFingerprint({ ...fingerprintFacts({}), group: snapshot });

        const leaderless = fingerprintOf(group);
        const firstDirector = fingerprintOf(toRtcTopologyGroupWithDirector(group, 'peer-2'));
        const secondDirector = fingerprintOf(toRtcTopologyGroupWithDirector(group, 'peer-3'));
        const absentDirector = fingerprintOf(toRtcTopologyGroupWithDirector(group, 'peer-4'));

        expect(new Set([leaderless, firstDirector, secondDirector]).size).toBe(3);
        expect(absentDirector).toBe(leaderless);
    });

    it('changes when the RTT reporting limit changes', () => {
        const narrow = computeRtcTopologyInputFingerprint(fingerprintFacts({}));
        const wide = computeRtcTopologyInputFingerprint({
            ...fingerprintFacts({}),
            rttReportingDegreeLimit: 6
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
        kindHysteresisWidths: { meshExitWidth: 1, treeExitWidth: 1 },
        rttReportingDegreeLimit: 5
    };
}
