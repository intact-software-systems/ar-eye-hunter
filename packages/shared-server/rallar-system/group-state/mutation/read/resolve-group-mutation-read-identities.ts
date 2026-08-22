import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';

import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    resolveGroupMutationTargetPrincipalId,
    resolveGroupMutationTargetSessionId
} from '../orchestration/resolve-group-mutation-target-identity.ts';

export interface GroupMutationReadIdentities {
    readonly actorPrincipalId: string | null;
    readonly targetPrincipalId: string | null;
    readonly ownerPrincipalId: string | null;
    readonly directorPrincipalId: string | null;
    readonly targetSessionId: string | null;
}

export function resolveGroupMutationReadIdentities(
    read: GroupMutationRead,
    command: GroupMutationCommand
): GroupMutationReadIdentities {
    return {
        actorPrincipalId: command.input.actorPrincipalId,
        targetPrincipalId: resolveGroupMutationTargetPrincipalId(command),
        ownerPrincipalId: read.group?.value.ownerPrincipalId ?? null,
        directorPrincipalId: readRallarGroupDirectorAppointment(read.group?.value.metadata)?.principalId ?? null,
        targetSessionId: resolveGroupMutationTargetSessionId(command)
    };
}
