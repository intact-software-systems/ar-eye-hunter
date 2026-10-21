import type { ValidationValue } from '../../protocol/validation-value.ts';
import { rejectClientMutation } from './client-mutation-rejection.ts';

export function assertClientBoolean(
    value: ValidationValue,
    label: string
): asserts value is boolean {
    if (typeof value !== 'boolean') {
        rejectClientMutation(`${label} must be a boolean`);
    }
}
