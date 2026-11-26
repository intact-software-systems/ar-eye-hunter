import { readRoomDirectorSuccession } from '@shared/api/room-directors/room-director-succession-record.ts';
import { groupStateUpdatePresenceAdmissionDescriptor, groupStateUpdatePresenceDescriptor } from '../../persistence/presence/group-presence-write-descriptors.ts';
import type { Group } from '@shared/api/group-types.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';

/** A disconnect or generation change after reading an eligible session must invalidate the appointment attempt. */
export function directorAuthorityFences(command: GroupMutationCommand, read: GroupMutationRead, group: Group): RuntimeStateGuardedBatchEffect[] {
    const managedDirectorChange = command.operation === 'appointDirector' && command.input.succession;
    const managedTimeChange = command.operation === 'updateGroup' &&
        (command.input.roomClock || command.input.roomDeadline?.expectedDirectorEpoch !== undefined) && readRoomDirectorSuccession(group.metadata);
    const managementTransfer = command.operation === 'transferGroupOwnership' && group.temporaryPlayerRoom === true;
    if (!managementTransfer && !managedDirectorChange && !managedTimeChange) return [];
    const effects = new Map<string, RuntimeStateGuardedBatchEffect>();
    for (const row of [read.targetPresence, ...read.authorityPresenceSessionEntries]) {
        if (!row) continue;
        const effectId = 'director-session:' + row.value.sessionId;
        effects.set(effectId, { ...groupStateUpdatePresenceDescriptor(row.value, row.entry.revision),
            effectId, operation: 'update-exact', expectedValue: row.entry.value });
    }
    for (const row of [read.targetAdmission, read.authorityAdmission, read.directorAdmission]) {
        if (!row) continue;
        const effectId = 'director-admission:' + row.value.principalId;
        effects.set(effectId, { ...groupStateUpdatePresenceAdmissionDescriptor(row.value, row.entry.revision),
            effectId, operation: 'update-exact', expectedValue: row.entry.value });
    }
    return [...effects.values()];
}
