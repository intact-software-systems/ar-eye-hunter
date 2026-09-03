import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeGroupConnectTrigger, type GroupConnectTriggerComputed } from '../aggregate/compute-group-connect-trigger.ts';
import { resolveGroupAuthorityPolicy } from '../aggregate/resolve-group-authority-policy.ts';
import {
    isGroupLifecycleTransitionOperation,
    type GroupMutationCommand,
    type GroupMutationComputed,
    type GroupMutationFacts,
    type GroupMutationRead
} from '../group-mutation-contracts.ts';
import { assertComputedGroupMutationEvent } from './assert-computed-group-mutation-event.ts';
import { assertComputedGroupMutationGuard } from './assert-computed-group-mutation-guard.ts';
import { assertComputedGroupMutationMembers } from './assert-computed-group-mutation-members.ts';
import { assertComputedGroupMutationOutbox } from './assert-computed-group-mutation-outbox.ts';
import { assertComputedGroupMutationReceipt } from './assert-computed-group-mutation-receipt.ts';

export interface AssertComputedGroupMutationWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'write'; }>;
}

export function assertComputedGroupMutationWrite(
    input: AssertComputedGroupMutationWriteInput
): void {
    const trigger = computeWrittenConnectTrigger(input);
    if (!jsonEquals(input.computed.connectTriggerLatchEffect, trigger.effect)) {
        throw new TypeError('Computed connect trigger effect differs from canonical intent');
    }
    assertComputedGroupMutationGuard(input);
    assertComputedGroupMutationMembers(input);
    assertComputedGroupMutationEvent(input);
    assertComputedGroupMutationReceipt(input);
    assertComputedGroupMutationOutbox(input);
}

/**
 * The connect trigger is a lifecycle transition's effect on the group row; a
 * corrupt stored policy never reaches a write because the transition compute
 * rejects it first.
 */
function computeWrittenConnectTrigger(
    input: AssertComputedGroupMutationWriteInput
): Pick<GroupConnectTriggerComputed, 'effect'> {
    const { command, read, computed } = input;
    if (!isGroupLifecycleTransitionOperation(command.operation) || computed.guard.kind !== 'group' || read.group === null) {
        return { effect: null };
    }
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return { effect: null };
    }
    return computeGroupConnectTrigger({
        ...input,
        next: computed.guard.value,
        policy: resolution.policy,
        previous: read.group.value.lifecycleState
    });
}
