import { computeExpectedLayoutFence } from '@shared/api/group-lifecycle/compute-expected-layout-fence.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { Group } from '@shared/api/group-types.ts';

import type {
    GroupLifecycleTransitionOperation,
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { rejected } from '../group-mutation-result.ts';
import { GroupConnectDenialError } from './group-connect-denial-error.ts';

interface LifecycleFenceInput {
    readonly command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly stored: Group;
}

export function computeLifecycleFenceRejection(
    { command, read, facts, stored }: LifecycleFenceInput
): GroupMutationComputed | null {
    const rejectedFence = (message: string) =>
        rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message });
    const expectedFormationEpoch = command.input.expectedFormationEpoch ?? null;
    if (expectedFormationEpoch !== null && expectedFormationEpoch !== stored.formationEpoch) {
        return rejectedFence(
            `Criterion petition fence is stale-epoch: expected ${expectedFormationEpoch}, ` +
                `stored ${stored.formationEpoch}`
        );
    }
    const expectedLayout = command.operation === 'activateGroup' ||
            command.operation === 'failGroupFormation' ||
            command.operation === 'connectGroup'
        ? command.input.expectedLayout ?? null
        : null;
    if (expectedLayout === null) {
        return null;
    }
    if (expectedFormationEpoch === null) {
        return rejectedFence('Criterion petition carries a layout fence without an epoch fence');
    }
    if (
        (command.operation === 'activateGroup' || command.operation === 'connectGroup') &&
        expectedLayout.state !== 'active'
    ) {
        return rejectedFence(`Group ${command.operation} fence names a removed layout`);
    }
    const fence = computeExpectedLayoutFence({
        expectedFormationEpoch,
        expectedLayout,
        currentFormationEpoch: stored.formationEpoch,
        currentPlannedLayout: read.plannedLayoutRow === null
            ? undefined
            : toGroupLayoutIdentity(read.plannedLayoutRow.snapshot)
    });
    if (fence === 'match') {
        return null;
    }
    // `connect` names the exact planned layout it dials; its two denials are
    // thrown typed conflicts the caller distinguishes and retries on
    // (product decision 32) — never a rejected receipt, never a no-op. The
    // epoch mismatch stays the shared stale-epoch rejection above.
    if (
        command.operation === 'connectGroup' &&
        (fence === 'no-planned-layout' || fence === 'planned-layout-superseded')
    ) {
        throw new GroupConnectDenialError(fence);
    }
    return rejectedFence(`Criterion petition fence is ${fence} for the stored planned layout`);
}
