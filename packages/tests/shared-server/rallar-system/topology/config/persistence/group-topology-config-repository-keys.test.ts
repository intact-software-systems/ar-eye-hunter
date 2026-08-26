import { describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateIdempotencyStorageKey } from '@shared-server/rallar-system/group-state/persistence/idempotency/group-idempotency-storage-key.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('group topology config repository keys', () => {
    it('uses canonical required-workspace keys across every topology namespace', () => {
        const repository = new GroupTopologyConfigRepository(new FakeRuntimeStateRepository());
        const refs: readonly GroupRef[] = [
            { applicationId: 'app:key', workspaceId: '_', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: 'a:b', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: 'a%3Ab', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: '%5F', groupId: 'room:key' },
            { applicationId: 'app:key', workspaceId: '＿', groupId: 'room:key' }
        ];

        for (const ref of refs) {
            const groupKey = groupStateGroupStorageKey(ref);
            expect(repository.configKey(ref)).toBe(groupKey);
            expect(repository.overrideKey(ref)).toBe(groupKey);
            expect(repository.mutationKey(ref, 'request:key')).toBe(
                groupStateIdempotencyStorageKey(ref, 'request:key')
            );
            expect(repository.generationKey(ref, 'config')).toBe(`${groupKey}:target=config`);
            expect(repository.invariantGenerationKey(ref)).toBe(`${groupKey}:invariant=effective-config`);
        }
        expect(new Set(refs.map((ref) => repository.configKey(ref))).size).toBe(refs.length);
    });

    it('keeps complete scoped and child identities injective for adversarial values', () => {
        const repository = new GroupTopologyConfigRepository(new FakeRuntimeStateRepository());
        const ref: GroupRef = {
            applicationId: 'app:key',
            workspaceId: '_',
            groupId: 'group:%3A'
        };

        expect(repository.configKey(ref)).toBe('app=app%3Akey:ws=_:group=group%3A%253A');
        expect(repository.overrideKey(ref)).toBe('app=app%3Akey:ws=_:group=group%3A%253A');
        expect(repository.generationKey(ref, 'config')).toBe(
            'app=app%3Akey:ws=_:group=group%3A%253A:target=config'
        );
        expect(repository.generationKey(ref, 'override')).toBe(
            'app=app%3Akey:ws=_:group=group%3A%253A:target=override'
        );
        expect(repository.invariantGenerationKey(ref)).toBe(
            'app=app%3Akey:ws=_:group=group%3A%253A:invariant=effective-config'
        );
        expect(repository.mutationKey(ref, 'target=config')).toBe(
            'app=app%3Akey:ws=_:group=group%3A%253A:request=target%3Dconfig'
        );

        expect(
            new Set([
                repository.generationKey(ref, 'config'),
                repository.generationKey(ref, 'override'),
                repository.invariantGenerationKey(ref),
                repository.mutationKey(ref, 'target=config')
            ])
        ).toHaveLength(4);
    });
});
