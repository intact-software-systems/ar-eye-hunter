/**
 * `connect` names the exact planned layout it dials (product decision 32).
 * These two conflicts travel as `ApiMutationFailure.code` with status 409 and
 * are the only lifecycle rejections a browser must tell apart from a policy
 * denial; the server registry spreads them so the wire spelling has one owner.
 */
export const GROUP_CONNECT_REJECTION_CODES = [
    'group-connect-no-planned-layout',
    'group-connect-planned-layout-superseded'
] as const;

export type GroupConnectRejectionCode = typeof GROUP_CONNECT_REJECTION_CODES[number];

export function isGroupConnectRejectionCode(code: string): code is GroupConnectRejectionCode {
    return GROUP_CONNECT_REJECTION_CODES.some((known) => known === code);
}
