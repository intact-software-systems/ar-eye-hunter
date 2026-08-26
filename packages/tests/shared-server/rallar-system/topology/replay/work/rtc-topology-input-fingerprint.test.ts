import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
    RtcTopologyInputFingerprintRepository
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-input-fingerprint.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { FakeRuntimeStateRepository } from '../../../../fake-runtime-state-repository.ts';

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
    ])('treats $label as a rebuild miss without deleting the row', async ({ value }) => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyInputFingerprintRepository(runtime);
        const key = groupStateGroupStorageKey(GROUP_REF);
        await runtime.upsert(
            RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE,
            key,
            JSON.stringify(value),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(repository.findFingerprint(GROUP_REF)).resolves.toBeNull();
        await expect(
            runtime.findEntry(RTC_TOPOLOGY_INPUT_FINGERPRINTS_NAMESPACE, key)
        ).resolves.toBeDefined();
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
