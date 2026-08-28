import type { GroupLifecyclePolicy, GroupTransportState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { Group } from '@shared/api/group-types.ts';

import { canCommandGroupAuthority } from '../../policy/group-lifecycle-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    GroupTransportOperation
} from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, noOp, requireGroup } from '../group-mutation-result.ts';
import { assertActive, assertAllowed, toGroupAuthorityPolicyInput } from './group-aggregate-mutation-policy.ts';
import { resolveGroupAuthorityPolicy, toCorruptPolicyRejection } from './resolve-group-authority-policy.ts';

const TRANSPORT_STATE_BY_OPERATION = {
    pauseGroupTransport: 'halted',
    resumeGroupTransport: 'flowing'
} as const satisfies Record<GroupTransportOperation, GroupTransportState>;

/**
 * The transport valve (product decision 25). Halting is a transport fact,
 * not a stage: the accepted layout stays accepted and connected, admission
 * and presence are unaffected, and the routing plane — stage, formation
 * epoch, electorate, establishment clock, armed timers — is untouched. The
 * valve is governed by the one group-authority initiator policy (product
 * decision 12) and is never automatic: no internal authority mode admits
 * these operations, so this compute has no service-authority arm.
 */
export function computeGroupTransportMutation(
    command: Extract<GroupMutationCommand, { operation: GroupTransportOperation; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    const resolution = resolveGroupAuthorityPolicy(read);
    if (resolution.status === 'corrupt') {
        return toCorruptPolicyRejection({ command, read, facts, reason: resolution.reason });
    }
    validateGroupTransportAuthority({ command, read, facts, policy: resolution.policy });
    const transportState = TRANSPORT_STATE_BY_OPERATION[command.operation];
    // The valve has no repair to perform, so a command that asks for the
    // state the group already holds changes nothing and pushes no delta.
    if (stored.value.transportState === transportState) {
        return noOp(command, read, facts);
    }
    const next: Group = {
        ...stored.value,
        transportState,
        snapshotVersion: stored.value.snapshotVersion + 1,
        updated: auditStamp(command, facts, command.input.actorPrincipalId ?? undefined)
    };
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: next,
            expectedRevision: stored.entry.revision
        },
        members: [],
        initialPresenceSummary: null,
        presenceAdmission: null,
        eventType: 'group-updated',
        presenceSummaryWork: 'enqueue'
    });
}

interface GroupTransportAuthorityInput {
    readonly command: Extract<GroupMutationCommand, { operation: GroupTransportOperation; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly policy: GroupLifecyclePolicy;
}

function validateGroupTransportAuthority(input: GroupTransportAuthorityInput): void {
    assertAllowed(canCommandGroupAuthority(toGroupAuthorityPolicyInput(input)));
}
