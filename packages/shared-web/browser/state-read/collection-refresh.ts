import {
    validateAuthoritativeClientSnapshotList,
    validateAuthoritativeGroupSnapshotList
} from '@shared/api/authoritative-state-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { CommandsOrchestrator, type CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';

import { requireStateWorkflowResult } from '../state-workflow-support.ts';
import {
    captureStateSnapshotCollectionObservations,
    reconcileCompleteStateSnapshotCollections
} from './reconciliation.ts';
import { listStateClients, listStateGroups } from './state-snapshot-http-api.ts';

type CollectionSnapshot = ClientSnapshot[] | GroupSnapshot[];

export interface CompleteStateSnapshotCollections {
    readonly clients: ClientSnapshot[];
    readonly groups: GroupSnapshot[];
}

export async function refreshCompleteStateSnapshotCollections(
    scope: StateScope,
    policies: CommandsOrchestratorPolicies<CollectionSnapshot>
): Promise<CompleteStateSnapshotCollections> {
    const observations = captureStateSnapshotCollectionObservations(scope);
    const flow = CommandsOrchestrator.withPolicies<'clients' | 'groups', CollectionSnapshot>(
        policies
    );
    const results = await flow
        .parallel(
            flow.commandStep('clients', (signal) => listStateClients(scope, { signal })),
            flow.commandStep('groups', (signal) => listStateGroups(scope, { signal }))
        )
        .run();
    const clients = requireStateWorkflowResult(results, 'clients');
    const groups = requireStateWorkflowResult(results, 'groups');
    validateAuthoritativeClientSnapshotList(clients, scope);
    validateAuthoritativeGroupSnapshotList(groups, scope);
    reconcileCompleteStateSnapshotCollections(observations, clients, groups);
    return { clients, groups };
}
