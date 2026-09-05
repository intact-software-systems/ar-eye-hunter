import { validateComputedProjection } from '../../../computed-data-validation.ts';
import type { ComputedDataValidationIssue } from '../../../computed-data-validation.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { computeGroupMutation } from '../orchestration/compute-group-mutation.ts';

export interface ValidateGroupMutationInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: GroupMutationComputed;
}

export function validateGroupMutation(
    input: ValidateGroupMutationInput
): readonly ComputedDataValidationIssue[] {
    const expected = computeGroupMutation({
        command: input.command,
        read: input.read,
        facts: input.facts
    });
    return validateComputedProjection(expected, input.computed, 'computed');
}
