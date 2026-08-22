import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { RuntimeStateJsonStore } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/RuntimeStateRepository.ts';
import { groupStateGroupStorageKey } from './group-state-storage-keys.ts';

export const GROUP_LIFECYCLE_POLICIES_NAMESPACE = 'group-state:lifecycle-policies';

type StoredGroupLifecyclePolicy = Readonly<{
    groupRef: GroupRef;
    policy: GroupLifecyclePolicy;
}>;

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
        const stored = await this.getValue<StoredGroupLifecyclePolicy>(
            GROUP_LIFECYCLE_POLICIES_NAMESPACE,
            groupStateGroupStorageKey(ref)
        );
        if (stored === undefined) {
            return { status: 'absent' };
        }
        if (!isSameGroupRef(stored.groupRef, ref)) {
            return {
                status: 'corrupt',
                reason: 'stored policy identity differs from the requested group'
            };
        }
        if (stored.policy === null || typeof stored.policy !== 'object') {
            return { status: 'corrupt', reason: 'stored policy is not an object' };
        }

        return validateGroupLifecyclePolicy(stored.policy).fold<GroupLifecyclePolicyRead>(
            (issues) => ({
                status: 'corrupt',
                reason: 'stored policy is no longer coherent: ' + issues.map((issue) => issue.code).join(', ')
            }),
            (policy) => ({ status: 'present', policy })
        );
    }

    async writePolicy(ref: GroupRef, policy: GroupLifecyclePolicy): Promise<void> {
        await this.putValue(
            GROUP_LIFECYCLE_POLICIES_NAMESPACE,
            groupStateGroupStorageKey(ref),
            {
                groupRef: ref,
                policy
            } satisfies StoredGroupLifecyclePolicy
        );
    }
}

function isSameGroupRef(left: GroupRef | undefined, right: GroupRef): boolean {
    return (
        left?.applicationId === right.applicationId &&
        left?.workspaceId === right.workspaceId &&
        left?.groupId === right.groupId
    );
}
