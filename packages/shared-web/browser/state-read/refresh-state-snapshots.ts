import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import { defaultStateScope } from '../api/state-http-path.ts';
import { refreshCompleteStateSnapshotCollections } from './collection-refresh.ts';

export interface StateSnapshots {
    readonly clients: ClientSnapshot[];
    readonly groups: GroupSnapshot[];
}

export type StateSnapshotsWorkflowValue = ClientSnapshot[] | GroupSnapshot[];

export async function refreshStateSnapshots(
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateSnapshotsWorkflowValue> = {}
): Promise<StateSnapshots> {
    return await refreshCompleteStateSnapshotCollections(scope, policies);
}
