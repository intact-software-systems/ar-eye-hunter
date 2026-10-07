import {
    readCurrentStateGroup,
    writeStateGroupMetadata
} from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
import {
    isRallarGroupDirectorForSession,
    RALLAR_GROUP_DIRECTOR_METADATA_KEY,
    readRallarGroupDirectorFromSnapshot
} from '@shared/api/group-director.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import type { GroupSnapshot } from '../rooms/room-group-state-translation.ts';

export interface ResignRoomDirectorInput {
    readonly groupId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly scope: StateScope;
    readonly policies: CommandsOrchestratorPolicies<GroupSnapshot>;
}

/** The room as the server holds it after the resignation, and whether it removed this session's appointment. */
export interface ResignRoomDirectorOutcome {
    readonly resigned: boolean;
    readonly snapshot: GroupSnapshot;
}

/**
 * Removes the room's director appointment while the server still names this session: an appointment this session's
 * cache shows, but the server has since given a successor, is left as it is.
 */
export async function resignStateGroupDirector(input: ResignRoomDirectorInput): Promise<ResignRoomDirectorOutcome> {
    const current = await readCurrentStateGroup(input);
    const appointment = readRallarGroupDirectorFromSnapshot(current);
    if (!isRallarGroupDirectorForSession(appointment, { clientId: input.principalId, sessionId: input.sessionId })) {
        return { resigned: false, snapshot: current };
    }
    const snapshot = await writeStateGroupMetadata({
        ...input,
        current,
        patch: { [RALLAR_GROUP_DIRECTOR_METADATA_KEY]: null }
    });
    return { resigned: true, snapshot };
}
