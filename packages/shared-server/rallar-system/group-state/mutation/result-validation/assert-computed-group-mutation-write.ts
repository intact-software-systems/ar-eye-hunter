import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeGroupConnectTrigger } from '../aggregate/compute-group-connect-trigger.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
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
    const trigger = input.computed.guard.kind === 'group'
        ? computeGroupConnectTrigger({ ...input, next: input.computed.guard.value })
        : { effect: null };
    if (!jsonEquals(input.computed.connectTriggerLatchEffect, trigger.effect)) {
        throw new TypeError('Computed connect trigger effect differs from canonical intent');
    }
    assertComputedGroupMutationGuard(input);
    assertComputedGroupMutationMembers(input);
    assertComputedGroupMutationEvent(input);
    assertComputedGroupMutationReceipt(input);
    assertComputedGroupMutationOutbox(input);
}
