export const GROUP_POLICY_REASON_CODES = [
    'group-policy-denied',
    'group-invite-required',
    'group-code-required',
    'group-code-invalid',
    'group-invite-expired',
    'group-archived',
    'group-deleted',
    'group-not-active',
    'group-full',
    'member-session-limit-reached',
    'member-not-active',
    'member-removed',
    'member-banned',
    'forbidden-role',
    'last-owner',
    'lifecycle-transition-invalid',
    'lifecycle-manager-unavailable',
    'group-admission-closed',
    'group-admission-deadline-passed',
    'group-admission-capacity-reached',
    'group-data-blocked-until-active'
] as const;

export type GroupPolicyReasonCode = typeof GROUP_POLICY_REASON_CODES[number];

export type GroupPolicyDenied = Readonly<{
    allowed: false;
    code: GroupPolicyReasonCode;
    message: string;
    details?: Record<string, unknown>;
}>;

export type GroupPolicyResult =
    | Readonly<{ allowed: true; }>
    | GroupPolicyDenied;
