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
 * `connect` names its epoch and its layout explicitly, so a mismatch of either
 * carries its own conflict code; its other refusals keep the shared one, as
 * every other command's do. Unfenced (principal) commands pass; absent, like
 * null, means no fence, though the wire decoders reject absent keys before
 * compute.
 */
export function computeLifecycleFenceRejection(input: LifecycleFenceInput): GroupMutationComputed | null {
    const { command, read, facts, stored } = input;
    const toSharedRejection = (message: string) =>
        rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message });
    const expectedFormationEpoch = command.input.expectedFormationEpoch ?? null;
    if (expectedFormationEpoch !== null && expectedFormationEpoch !== stored.formationEpoch) {
        const epochs = `expected ${expectedFormationEpoch}, stored ${stored.formationEpoch}`;
        return toFenceRejection(input, 'stale-epoch', `Group ${command.operation} fence is stale-epoch (${epochs})`);
    }
    if (
        command.operation === 'connectGroup' && facts.internalAuthority === 'formation-automation' &&
        (read.connectTriggerLatch === null || read.connectTriggerLatch.latch.state !== 'awaiting-publication')
    ) {
        return toSharedRejection('Automatic connect trigger is absent or consumed');
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
        return toSharedRejection('Criterion petition carries a layout fence without an epoch fence');
    }
    if (
        (command.operation === 'activateGroup' || command.operation === 'connectGroup') &&
        expectedLayout.state !== 'active'
    ) {
        return toSharedRejection(`Group ${command.operation} fence names a removed layout`);
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
    return toFenceRejection(input, fence, `Group ${command.operation} fence is ${fence}`);
}

function toFenceRejection(
    { command, read, facts }: LifecycleFenceInput,
    fence: LifecycleFenceMismatch,
    message: string
): GroupMutationComputed {
    return rejected({
        command,
        read,
        facts,
        rejectionCode: command.operation === 'connectGroup' ? `group-connect-${fence}` : 'group-mutation-rejected',
        message
    });
}
