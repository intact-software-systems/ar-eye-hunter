import { groupStateInsertGroupDescriptor } from '../../persistence/aggregate/group-aggregate-write-descriptors.ts';
import type { GroupMutationRead } from '../group-mutation-contracts.ts';
import { computeGroupMutation, type GroupMutationInput } from '../orchestration/compute-group-mutation.ts';
import {
    computeGroupCohortAdmission,
    type GroupCohortAdmissionParticipant,
    type GroupCohortAdmissionResult
} from './compute-group-cohort-admission.ts';

export interface NewGroupCohortAdmissionInput {
    readonly creation: GroupMutationInput;
    readonly participants: readonly GroupCohortAdmissionParticipant[];
}

/** Stage a new room first, then use the same admission policy as cohorts entering existing rooms. */
export function computeNewGroupCohortAdmission(input: NewGroupCohortAdmissionInput): GroupCohortAdmissionResult {
    if (input.creation.command.operation !== 'createGroup') {
        throw new TypeError('A new cohort requires an ordinary group creation command');
    }
    const created = computeGroupMutation(input.creation);
    if (
        created.outcome !== 'write' || created.guard.kind !== 'group' || created.guard.operation !== 'insert' ||
        created.lifecyclePolicy === null || input.creation.read.expiredGroupEntry !== null
    ) {
        throw new TypeError('A new cohort requires a fresh exclusive room identity');
    }
    if (input.participants.some((participant) => participant.read.group !== null)) {
        return { status: 'conflict' };
    }
    const descriptor = groupStateInsertGroupDescriptor(created.guard.value);
    const group: NonNullable<GroupMutationRead['group']> = {
        value: created.guard.value,
        entry: {
            key: descriptor.key,
            value: descriptor.value,
            expireAtTimestamp: descriptor.expireAtTimestamp,
            revision: 0,
            updatedTimestamp: new Date(input.creation.facts.nowEpochMs).toISOString()
        }
    };
    const policy = created.lifecyclePolicy;
    const participants = input.participants.map((participant): GroupCohortAdmissionParticipant => {
        if (participant.command.targetPrincipalId === group.value.ownerPrincipalId) {
            throw new TypeError('The new room creator is already admitted by creation');
        }
        return {
            ...participant,
            read: {
                ...participant.read,
                group,
                activeMembers: created.members,
                lifecyclePolicy: { status: 'present', policy }
            }
        };
    });
    const admitted = computeGroupCohortAdmission({ participants });
    return admitted.status === 'admitted' ? { ...admitted, mutations: [created, ...admitted.mutations] } : admitted;
}
