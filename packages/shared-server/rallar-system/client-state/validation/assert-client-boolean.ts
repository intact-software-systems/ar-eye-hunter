import { rejectClientMutation } from './client-mutation-rejection.ts';
import type { ClientValidationValue } from './client-record-validation.ts';

export function assertClientBoolean(
    value: ClientValidationValue,
    label: string
): asserts value is boolean {
    if (typeof value !== 'boolean') {
        rejectClientMutation(`${label} must be a boolean`);
    }
}
