import { assertGroupMutationAuthority } from '../command-validation/assert-group-mutation-authority.ts';
import { assertGroupMutationCommand } from '../command-validation/assert-group-mutation-command.ts';
import { assertGroupMutationFacts } from './assert-group-mutation-facts.ts';
import { assertGroupMutationRead } from './assert-group-mutation-read.ts';
import {
    validateGroupMutation,
    type ValidateGroupMutationInput
} from './validate-group-mutation.ts';

export function assertGroupMutation(
    input: ValidateGroupMutationInput
): void {
    assertGroupMutationCommand(input.command);
    assertGroupMutationRead(input.read, input.command);
    assertGroupMutationFacts(input.facts);
    assertGroupMutationAuthority(input.command, input.facts);
    const issue = validateGroupMutation(input)[0];
    if (issue !== undefined) {
        throw issue.cause;
    }
}
