import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { isGroupConnectRejectionCode } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import { isGroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';

import type { RallarRoomFormationDenial } from './rallar-room-formation-contracts.ts';

export function toRoomFormationDenial<T>(error: T): RallarRoomFormationDenial | undefined {
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
