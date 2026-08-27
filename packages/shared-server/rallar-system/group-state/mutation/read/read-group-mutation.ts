import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    isGroupAdmissionDecisionOperation,
    isGroupAdmissionPolicyReadOperation,
    isGroupLifecycleTransitionOperation
} from '../group-mutation-contracts.ts';
import { readExactGroupMutation } from './read-exact-group-mutation.ts';
import { readSequentialGroupMutation } from './read-sequential-group-mutation.ts';

export async function readGroupMutation(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    plannedLayoutIdentity: GroupLayoutIdentity | null
): Promise<GroupMutationRead> {
    // Safe beside the exact batch because the policy document is written once
    // at creation and never updated in this release; a policy-update surface
    // must move this into the batch's stability window.
    const lifecyclePolicy = isGroupLifecycleTransitionOperation(command.operation) ||
            isGroupAdmissionPolicyReadOperation(command.operation)
        ? await repository.readLifecyclePolicy(command.aggregateRef)
        : null;
    const requiresSequentialRead = command.operation === 'appointDirector' ||
        isGroupLifecycleTransitionOperation(command.operation) ||
        isGroupAdmissionDecisionOperation(command.operation);
    if (!requiresSequentialRead) {
        const exactRead = await readExactGroupMutation({
            repository,
            command,
            lifecyclePolicy
        });
        if (exactRead !== null) {
            return exactRead;
        }
    }
    return await readSequentialGroupMutation({
        repository,
        command,
        lifecyclePolicy,
        plannedLayoutIdentity
    });
}
