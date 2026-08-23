import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    resolveGroupLifecycleManagers,
    toGroupLifecycleElectionKey
} from '@shared/api/group-lifecycle/resolve-group-lifecycle-managers.ts';
import type { GroupPolicyDenied } from '@shared/api/group-policy-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { denyGroupPolicy, type GroupPolicyActor } from './group-policy-result.ts';

export interface GroupLifecycleManagerPolicyInput {
    readonly snapshot: GroupSnapshot;
    readonly actor: GroupPolicyActor;
    readonly policy: GroupLifecyclePolicy;
    readonly activeMemberPrincipalIds: readonly string[];
}

export function denyUnlessGroupLifecycleManager(
    input: GroupLifecycleManagerPolicyInput,
    message: string
): GroupPolicyDenied | undefined {
    const managers = resolveGroupLifecycleManagers({
        manager: input.policy.manager,
        ownerPrincipalId: input.snapshot.group.ownerPrincipalId,
        formationElectorate: input.snapshot.group.formationElectorate,
        formationEpoch: input.snapshot.group.formationEpoch,
        groupKey: toGroupLifecycleElectionKey(input.snapshot.group),
        activePrincipalIds: new Set(input.activeMemberPrincipalIds),
        rankByPrincipalId: null
    });
    if (managers.length === 0) {
        return denyGroupPolicy(
            'lifecycle-manager-unavailable',
            'No group manager resolves under this policy.'
        );
    }
    const principalId = input.actor.principalId;
    return principalId !== undefined && managers.includes(principalId)
        ? undefined
        : denyGroupPolicy('forbidden-role', message);
}
