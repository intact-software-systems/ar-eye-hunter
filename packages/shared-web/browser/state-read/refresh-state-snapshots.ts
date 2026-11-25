import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import { defaultStateScope } from '../api/state-http-path.ts';
import { readStateClientSnapshot, readStateGroupSnapshot } from './point-read.ts';
import { refreshCompleteStateSnapshotCollections } from './collection-refresh.ts';

export interface StateSnapshots {
    readonly clients: ClientSnapshot[];
    readonly groups: GroupSnapshot[];
}

export type StateSnapshotsWorkflowValue = ClientSnapshot[] | GroupSnapshot[];

export async function refreshStateSnapshots(
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateSnapshotsWorkflowValue> = {},
    session?: AuthSession
): Promise<StateSnapshots> {
    if (session?.guestRoom) {
        if (!isSameGroupScope(scope, session.guestRoom)) {
            throw new Error('Guest session belongs to another room scope.');
        }
        const options = { authSession: session, signal: policies.command?.signal };
        const [client, group] = await Promise.all([
            readStateClientSnapshot(session.clientId, scope, options),
            readStateGroupSnapshot(session.guestRoom.groupId, scope, options)
        ]);
        return { clients: [client.snapshot], groups: [group.snapshot] };
    }
    return await refreshCompleteStateSnapshotCollections(scope, policies);
}
