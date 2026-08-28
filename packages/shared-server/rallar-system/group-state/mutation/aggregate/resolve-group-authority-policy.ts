import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';

import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { rejected } from '../group-mutation-result.ts';

export type GroupAuthorityPolicyResolution =
    | Readonly<{ status: 'resolved'; policy: GroupLifecyclePolicy; }>
    | Readonly<{ status: 'corrupt'; reason: string; }>;

/**
 * The one reader of the stored lifecycle policy for the group-authority
 * commands. An unreadable document must never read as permissive, so it is
 * surfaced as a value rather than a policy; an absent one resolves to the
 * default preset. A missing read is a programmer invariant — the read path
 * and its validator both key on the read scope's policy rule.
 */
export function resolveGroupAuthorityPolicy(
    read: GroupMutationRead
): GroupAuthorityPolicyResolution {
    if (read.lifecyclePolicy === null) {
        throw new TypeError('Group authority compute requires the policy read');
    }
    if (read.lifecyclePolicy.status === 'corrupt') {
        return { status: 'corrupt', reason: read.lifecyclePolicy.reason };
    }
    return {
        status: 'resolved',
        policy: read.lifecyclePolicy.status === 'present'
            ? read.lifecyclePolicy.policy
            : createDefaultGroupLifecyclePolicy()
    };
}

export interface CorruptPolicyRejectionInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly reason: string;
}

/** Fail closed: an unreadable stored policy must not read as permissive. */
export function toCorruptPolicyRejection(
    input: CorruptPolicyRejectionInput
): GroupMutationComputed {
    return rejected({
        command: input.command,
        read: input.read,
        facts: input.facts,
        rejectionCode: 'group-mutation-rejected',
        message: `Group lifecycle policy is unreadable: ${input.reason}`
    });
}
