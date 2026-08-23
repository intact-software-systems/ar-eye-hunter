import type { GroupPolicyDenied, GroupPolicyReasonCode, GroupPolicyResult } from '@shared/api/group-policy-types.ts';

export interface GroupPolicyActor {
    readonly principalId?: string;
    readonly sessionId?: string;
    readonly serviceId?: string;
}

export const GROUP_POLICY_ALLOWED: GroupPolicyResult = { allowed: true };

export class GroupPolicyDeniedError extends Error {
    public override readonly name = 'GroupPolicyDeniedError';
    public readonly status = 403;
    public readonly denial: GroupPolicyDenied;

    public constructor(denial: GroupPolicyDenied) {
        super(`Forbidden: ${denial.message}`);
        this.denial = denial;
    }
}

export function isGroupPolicyDeniedError(error: unknown): error is GroupPolicyDeniedError {
    return error instanceof GroupPolicyDeniedError;
}

export function denyGroupPolicy(
    code: GroupPolicyReasonCode,
    message: string,
    details?: Record<string, unknown>
): GroupPolicyDenied {
    return { allowed: false, code, message, details };
}
