import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { isGroupConnectRejectionCode } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import { isGroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import type { RallarRoomFormationDenial } from './rallar-room-formation-contracts.ts';

/**
 * The facade refuses `connect` locally when no planned layout is published,
 * the same condition the server answers with its typed conflict; both read as
 * the one layout denial.
 */
export function toRoomFormationDenial<T>(error: T): RallarRoomFormationDenial | undefined {
    const localRefusal = isRallarValidationError(error)
        ? error.issues.find((issue) => issue.code === 'no-planned-layout')
        : undefined;
    if (localRefusal !== undefined) {
        return { kind: 'layout', code: 'group-connect-no-planned-layout', message: localRefusal.message };
    }
    if (!(error instanceof ApiHttpError) || error.mutationFailure === undefined) {
        return undefined;
    }
    const { code, message } = error.mutationFailure;
    if (isGroupConnectRejectionCode(code)) {
        return { kind: 'layout', code, message };
    }
    if (isGroupPolicyReasonCode(code)) {
        return { kind: 'policy', code, message };
    }
    return undefined;
}
