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

interface LifecycleFenceInput {
    readonly command: Extract<GroupMutationCommand, { operation: GroupLifecycleTransitionOperation; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly stored: Group;
}

/**
 * The causal fence (product decisions 19 and 32): a command carrying an old
 * epoch, a layout identity that is no longer the stored plan, or a removed
 * layout as a dialing target is a typed rejection that writes no state, event,
 * or receipt effect — never a wrong transition and never a silent no-op.
 * `connect` names its layout explicitly, so its two mismatches carry their
 * own conflict codes (product decision 32) rather than the shared one. Unfenced (principal) commands pass; absent, like null, means no
 * fence, though the wire decoders reject absent keys before compute.
 */
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
    if (
        command.operation === 'connectGroup' && facts.internalAuthority === 'formation-automation' &&
        (read.connectTriggerLatch === null || read.connectTriggerLatch.latch.state !== 'awaiting-publication')
    ) {
        return rejectedFence('Automatic connect trigger is absent or consumed');
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
    return rejectLayoutFence({ command, read, facts, stored }, fence);
}

function rejectLayoutFence(
    { command, read, facts }: LifecycleFenceInput,
    fence: ReturnType<typeof computeExpectedLayoutFence>
): GroupMutationComputed {
    // `connect` names the exact planned layout it dials, so its two denials
    // are distinguishable conflict codes the caller retries against the
    // current identity (product decision 32) — typed rejection values here,
    // mapped to their own 409 at the handler boundary like every other
    // rejection code. The epoch mismatch stays the shared stale-epoch
    // rejection above; a fence naming a tombstone is refused before this.
    if (
        command.operation === 'connectGroup' &&
        (fence === 'no-planned-layout' || fence === 'planned-layout-superseded')
    ) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: `group-connect-${fence}`,
            message: `Group connect names a layout that is ${fence}`
        });
    }
    return rejected({
        command,
        read,
        facts,
        rejectionCode: 'group-mutation-rejected',
        message: `Criterion petition fence is ${fence} for the stored planned layout`
    });
}
