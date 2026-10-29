import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import {
    GROUP_PUBLICATION_GRANT_LIMITS,
    type GroupPublicationTopicGrants
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupMember } from '@shared/api/group-types.ts';

import { denyGroupPolicy, GROUP_POLICY_ALLOWED } from './group-policy-result.ts';

export interface CanChangeGroupPublicationGrantInput {
    readonly target: GroupMember | undefined;
    readonly grantsPublish: boolean;
}

/** Grants are held by active members only, and a spectator may subscribe but is never granted publish (D501). */
export function canChangeGroupPublicationGrant(input: CanChangeGroupPublicationGrantInput): GroupPolicyResult {
    if (input.target?.status !== 'active') {
        return denyGroupPolicy('member-not-active', 'Only an active member holds publication grants.');
    }
    return input.grantsPublish && input.target.role === 'spectator'
        ? denyGroupPolicy('forbidden-role', 'A spectator may subscribe but is never granted publish.')
        : GROUP_POLICY_ALLOWED;
}

export function canHoldGroupPublicationTopics(topics: GroupPublicationTopicGrants): GroupPolicyResult {
    const max = GROUP_PUBLICATION_GRANT_LIMITS.maxTopicsPerPrincipal;
    return Object.keys(topics).length <= max
        ? GROUP_POLICY_ALLOWED
        : denyGroupPolicy('capacity', `A principal holds at most ${max} granted topics.`, {
            limit: 'topics-per-principal',
            max
        });
}
