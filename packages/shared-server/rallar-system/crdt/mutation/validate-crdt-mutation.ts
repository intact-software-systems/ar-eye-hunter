import { validateComputedProjection } from '../../validation/computed-data-validation.ts';
import { computeCrdtMutation } from './compute-crdt-mutation.ts';
import type {
    CrdtMutationComputed,
    CrdtMutationValidationIssue,
    ValidateCrdtMutationInput
} from './crdt-mutation-contracts.ts';

export function validateCrdtMutation(
    input: ValidateCrdtMutationInput
): readonly CrdtMutationValidationIssue[] {
    let expected: CrdtMutationComputed;
    try {
        expected = computeCrdtMutation({
            command: input.command,
            read: input.read,
            serviceId: input.serviceId
        });
    }
    catch (caught) {
        return [{
            code: 'computed-input-invalid',
            message: caught instanceof Error ? caught.message : String(caught)
        }];
    }

    const projectionIssues = validateComputedProjection(expected, input.computed, 'computed');
    if (projectionIssues.length > 0) {
        return projectionIssues.map((issue) => ({
            code: 'computed-mutation-differs',
            message: `CRDT ${issue.message}`
        }));
    }
    if (input.computed.command !== input.command || input.computed.read !== input.read) {
        return [{
            code: 'computed-mutation-differs',
            message: 'CRDT computed mutation does not retain its original command and read facts'
        }];
    }
    return [];
}
