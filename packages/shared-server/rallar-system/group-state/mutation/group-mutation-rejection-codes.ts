import {
    GROUP_CONNECT_REJECTION_CODES,
    type GroupConnectRejectionCode
} from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';

/** The registry the type and every runtime check derive from. */
export const GROUP_MUTATION_REJECTION_CODES = [
    'group-already-exists',
    'group-mutation-rejected',
    'group-policy-denied',
    ...GROUP_CONNECT_REJECTION_CODES
] as const;

export type GroupMutationRejectionCode = typeof GROUP_MUTATION_REJECTION_CODES[number];

/**
 * The registry's runtime mirror: a decoded result carries a declared code
 * type, so this proves the value is one the registry still lists rather
 * than a stale spelling that survived a rename.
 */
export function isGroupMutationRejectionCode(code: GroupMutationRejectionCode): boolean {
    return GROUP_MUTATION_REJECTION_CODES.some((known) => known === code);
}

/**
 * The handler-boundary error for the conflicts `GROUP_CONNECT_REJECTION_CODES`
 * owns; the AppInbox classifier reads the status from the instance. The
 * denial is a typed rejection value through compute and becomes this error
 * only at the handler boundary, like every other rejection code.
 *
 * A retry must carry a FRESH request id: the request id is the command
 * identity, so a retry that changes the fences under the old id is an
 * idempotency conflict, and an identical retry replays this same denial.
 */
export class GroupConnectDeniedError extends Error {
    readonly status = 409;
    readonly code: GroupConnectRejectionCode;

    constructor(
        code: GroupConnectRejectionCode,
        message: string
    ) {
        super(message);
        this.name = 'GroupConnectDeniedError';
        this.code = code;
    }
}
