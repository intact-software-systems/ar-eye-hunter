import type { ClientPrincipalRef } from '@shared/api/client-types.ts';

import type { ValidationValue } from '../../protocol/validation-value.ts';
import { decodeClientValidationRecord, requireExactKeys } from './client-record-validation.ts';
import { requireNonEmptyString } from './client-string-validation.ts';

export function validateClientPrincipalRef(
    value: ValidationValue,
    label: string,
    exact = true
): ClientPrincipalRef {
    const ref = decodeClientValidationRecord(value, label);
    if (exact) {
        requireExactKeys(ref, ['applicationId', 'workspaceId', 'principalId'], label);
    }
    requireNonEmptyString(ref.applicationId, `${label}.applicationId`);
    requireNonEmptyString(ref.workspaceId, `${label}.workspaceId`);
    requireNonEmptyString(ref.principalId, `${label}.principalId`);
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        principalId: ref.principalId
    };
}
