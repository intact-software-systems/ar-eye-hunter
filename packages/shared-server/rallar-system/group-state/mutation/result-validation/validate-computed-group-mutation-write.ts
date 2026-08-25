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
    validateComputedGroupMutationGuard(input);
    validateComputedGroupMutationMembers(input);
    validateComputedGroupMutationEvent(input);
    validateComputedGroupMutationReceipt(input);
    validateComputedGroupMutationOutbox(input);
}
