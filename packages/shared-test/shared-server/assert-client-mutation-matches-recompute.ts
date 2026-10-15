import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import type { ClientMutationAssertionInput } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { assertClientMutationInvariants } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { ClientMutationRejectedError } from '@shared-server/rallar-system/client-state/validation/client-mutation-rejection.ts';
import { validateComputedProjection } from '@shared-server/rallar-system/computed-data-validation.ts';

/**
 * The client-mutation slice of the AppInbox operation validation: a complete recompute compared exactly, then the
 * identity and guard invariants. Production validates the whole operation; tests that hold only a mutation use this.
 */
export function assertClientMutationMatchesRecompute(input: ClientMutationAssertionInput): void {
    const issue = validateComputedProjection(
        computeClientMutation({ command: input.command, read: input.read }),
        input.computed,
        'Client mutation computed'
    )[0];
    if (issue) {
        throw new ClientMutationRejectedError(issue.message);
    }
    assertClientMutationInvariants(input);
}
