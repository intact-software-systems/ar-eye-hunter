import {
    computeExpectedLayoutFence,
    type ExpectedLayoutFenceOutcome
} from '@shared/api/group-lifecycle/compute-expected-layout-fence.ts';
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

type LifecycleFenceMismatch = Exclude<ExpectedLayoutFenceOutcome, 'match'>;

/**
 * The causal fence (product decisions 19 and 32): a command carrying an old
 * epoch, a layout identity that is no longer the stored plan, or a removed
 * layout as a dialing target is a typed rejection that writes no state, event,
 * or receipt effect — never a wrong transition and never a silent no-op.
 * `connect` names its epoch and its layout explicitly, so each of its
 * mismatches carries its own conflict code rather than the shared one.
 * Unfenced (principal) commands pass; absent, like null, means no fence,
 * though the wire decoders reject absent keys before compute.
 */
export function computeLifecycleFenceRejection(input: LifecycleFenceInput): GroupMutationComputed | null {
    const { command, read, facts, stored } = input;
    const rejectedFence = (message: string) =>
        rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message });
    const expectedFormationEpoch = command.input.expectedFormationEpoch ?? null;
    if (expectedFormationEpoch !== null && expectedFormationEpoch !== stored.formationEpoch) {
        return rejectFence(input, 'stale-epoch');
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
    return rejectFence(input, fence);
}

/**
 * `connect` retries against the current snapshot, so each of its mismatches
 * is a distinguishable conflict code (product decision 32; the stale epoch
 * joined the two layout conflicts with the browser surface's settled question
 * Q3) — a typed rejection value here, mapped to its own 409 at the handler
 * boundary like every other rejection code. Every other fenced command keeps
 * the shared rejection; a fence naming a tombstone is refused before this.
 */
function rejectFence(
    { command, read, facts, stored }: LifecycleFenceInput,
    fence: LifecycleFenceMismatch
): GroupMutationComputed {
    const detail = fence === 'stale-epoch'
        ? `(expected ${command.input.expectedFormationEpoch}, stored ${stored.formationEpoch})`
        : 'for the stored planned layout';
    if (command.operation === 'connectGroup') {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: `group-connect-${fence}`,
            message: `Group connect fence is ${fence} ${detail}`
        });
    }
    return rejected({
        command,
        read,
        facts,
        rejectionCode: 'group-mutation-rejected',
        message: `Criterion petition fence is ${fence} ${detail}`
    });
}
