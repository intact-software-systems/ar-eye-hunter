import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import {
    computeAppOutboxInsertOrMatch,
    writeAppOutboxInsertOrMatch,
    type AppOutboxInsertOrMatch
} from '../../../app-outbox/app-outbox-insert.ts';
import { computeGroupConnectTriggerEntry } from '../../../group-state/group-connect-trigger-outbox-entry.ts';
import { GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS } from '../../../group-state/group-state-service-contracts.ts';
import { serializeCanonicalJson } from '../../../protocol/canonical-json.ts';
import type { GroupFormationAutomationPort } from './create-group-connect-trigger-work-handler.ts';

export interface PublicationConnectTriggerRequestsInput {
    readonly automation: GroupFormationAutomationPort | undefined;
    readonly target: RallarOverlayTopologySnapshot | null;
    readonly entry: ResourceEntry;
}

export function computePublicationConnectTriggerRequests(
    input: PublicationConnectTriggerRequestsInput
): readonly AppOutboxInsertOrMatch[] {
    const { automation, target, entry } = input;
    if (automation === undefined || target === null || target.state !== 'active') {
        return [];
    }
    return [computeAppOutboxInsertOrMatch(computeGroupConnectTriggerEntry({
        work: {
            kind: 'publication',
            groupRef: target.groupRef,
            wakeIdentity: serializeCanonicalJson({ source: entry.key, expectedLayout: toGroupLayoutIdentity(target) })
        },
        senderId: entry.audit.createdBy,
        createdAtEpochMs: entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
        expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS
    }))];
}

export async function writeGroupConnectTriggerRequests(
    transaction: PSqlSql,
    requests: readonly AppOutboxInsertOrMatch[]
): Promise<void> {
    for (const request of requests) {
        await writeAppOutboxInsertOrMatch(transaction, request);
    }
}
