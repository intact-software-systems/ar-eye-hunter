import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeGroupConnectTrigger } from '../aggregate/compute-group-connect-trigger.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { validateComputedGroupMutationEvent } from './validate-computed-group-mutation-event.ts';
import { validateComputedGroupMutationGuard } from './validate-computed-group-mutation-guard.ts';
import { validateComputedGroupMutationMembers } from './validate-computed-group-mutation-members.ts';
import { validateComputedGroupMutationOutbox } from './validate-computed-group-mutation-outbox.ts';
import { validateComputedGroupMutationReceipt } from './validate-computed-group-mutation-receipt.ts';

export interface ValidateComputedGroupMutationWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'write'; }>;
}

export function validateComputedGroupMutationWrite(
    input: ValidateComputedGroupMutationWriteInput
): void {
    const trigger = input.computed.guard.kind === 'group'
        ? computeGroupConnectTrigger({ ...input, next: input.computed.guard.value })
        : { effect: null };
    if (!jsonEquals(input.computed.connectTriggerLatchEffect, trigger.effect)) {
        throw new TypeError('Computed connect trigger effect differs from canonical intent');
    }
    validateComputedGroupMutationGuard(input);
    validateComputedGroupMutationMembers(input);
    validateComputedGroupMutationEvent(input);
    validateComputedGroupMutationReceipt(input);
    validateComputedGroupMutationOutbox(input);
}
