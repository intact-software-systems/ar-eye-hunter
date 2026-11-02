import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { assertGroupMutationAuthority } from '../command-validation/assert-group-mutation-authority.ts';
import { assertGroupMutationCommand } from '../command-validation/assert-group-mutation-command.ts';
import type { GroupMutationRead } from '../group-mutation-contracts.ts';
import { assertGroupMutationFacts } from '../state-validation/assert-group-mutation-facts.ts';
import { assertGroupMutationRead } from '../state-validation/assert-group-mutation-read.ts';
import type { GroupCohortAdmissionParticipant } from './compute-group-cohort-admission.ts';

export function validateGroupCohortReads(
    participants: readonly GroupCohortAdmissionParticipant[],
    first: GroupCohortAdmissionParticipant
): boolean {
    const admissions = new Map<string, GroupMutationRead['targetAdmission']>();
    for (const participant of participants) {
        assertGroupMutationCommand(participant.command);
        assertGroupMutationRead(participant.read, participant.command);
        assertGroupMutationFacts(participant.facts);
        assertGroupMutationAuthority(participant.command, participant.facts);
        if (participant.command.operation !== 'joinGroup' || participant.command.input.participation !== 'player') {
            throw new TypeError('A group cohort requires explicit player admission');
        }
        const principalId = participant.command.targetPrincipalId;
        const previous = admissions.get(principalId);
        if (
            admissions.has(principalId) &&
            (previous?.entry.revision !== participant.read.targetAdmission?.entry.revision ||
                previous?.entry.value !== participant.read.targetAdmission?.entry.value)
        ) {
            return false;
        }
        admissions.set(principalId, participant.read.targetAdmission);
        if (!isSameGroupRef(first.command.aggregateRef, participant.command.aggregateRef)) {
            throw new TypeError('Group cohort participants must name the same destination');
        }
        if (
            participant.read.group?.entry.revision !== first.read.group?.entry.revision ||
            participant.read.group?.entry.value !== first.read.group?.entry.value
        ) {
            return false;
        }
    }
    return true;
}
