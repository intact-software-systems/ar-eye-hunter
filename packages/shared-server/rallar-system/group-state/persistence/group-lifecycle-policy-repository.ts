import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { RuntimeStateJsonStore } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import {
    decodeCurrentGroupLifecyclePolicy,
    decodeStoredGroupLifecyclePolicy,
    type StoredGroupLifecyclePolicy
} from './decode-stored-group-lifecycle-policy.ts';
import { groupStateGroupStorageKey } from './group-state-storage-keys.ts';

export const GROUP_LIFECYCLE_POLICIES_NAMESPACE = 'group-state:lifecycle-policies';

/**
 * `absent` and `corrupt` are separate outcomes on purpose. A neighbouring store
 * decodes a bad row as absent because failing open there only costs a rebuild;
 * here it would silently reopen a group whose stored policy closed it. Storage
 * therefore reports what it found and the enforcement point decides, rather
 * than one failure posture being baked in before there is an enforcer.
 */
export type GroupLifecyclePolicyRead =
    | Readonly<{ status: 'absent'; }>
    | Readonly<{ status: 'present'; policy: GroupLifecyclePolicy; }>
    | Readonly<{ status: 'corrupt'; reason: string; }>;

export class GroupLifecyclePolicyRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;

    constructor(runtimeRepository: RuntimeStateRepositoryLike) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
    }

    async readPolicy(ref: GroupRef): Promise<GroupLifecyclePolicyRead> {
        const stored = await this.getJsonValue(
            GROUP_LIFECYCLE_POLICIES_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        if (stored === undefined) {
            return { status: 'absent' };
        }
        try {
            const decoded = decodeStoredGroupLifecyclePolicy(stored, ref);
            return { status: 'present', policy: decoded.policy };
        }
        catch (error) {
            return {
                status: 'corrupt',
                reason: error instanceof Error ? error.message : 'Stored group lifecycle policy is invalid'
            };
        }
    }

    async writePolicy(ref: GroupRef, policy: GroupLifecyclePolicy): Promise<void> {
        const currentPolicy = decodeCurrentGroupLifecyclePolicy(
            decodeJsonWireValue(policy, 'Group lifecycle policy')
        );
        await this.putValue(
            GROUP_LIFECYCLE_POLICIES_NAMESPACE,
            groupStateGroupStorageKey(ref),
            {
                groupRef: ref,
                policy: currentPolicy
            } satisfies StoredGroupLifecyclePolicy
        );
    }
}
