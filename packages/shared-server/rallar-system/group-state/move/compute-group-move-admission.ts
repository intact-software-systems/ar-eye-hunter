import type { GroupMoveAdmissionFailure } from '@shared/api/mutation/group-move.ts';
import type { GroupMutationComputedWrite } from '../mutation/group-mutation-contracts.ts';
import {
    computeGroupCohortAdmission,
    type GroupCohortAdmissionInput
} from '../mutation/membership/compute-group-cohort-admission.ts';

export type GroupMoveAdmissionResult =
    | Readonly<{ status: 'conflict'; }>
    | Readonly<{ status: 'admitted'; mutations: readonly GroupMutationComputedWrite[]; }>
    | (Readonly<{ status: 'denied'; }> & GroupMoveAdmissionFailure);

/** Translate shared admission failures to the existing Move together response contract. */
export function computeGroupMoveAdmission(input: GroupCohortAdmissionInput): GroupMoveAdmissionResult {
    const result = computeGroupCohortAdmission(input);
    if (result.status !== 'denied') {
        return result;
    }
    return {
        ...result,
        code: result.code === 'destination-missing'
            ? 'group-move-destination-missing'
            : result.code === 'approval-required'
            ? 'group-move-approval-required'
            : result.code
    };
}
