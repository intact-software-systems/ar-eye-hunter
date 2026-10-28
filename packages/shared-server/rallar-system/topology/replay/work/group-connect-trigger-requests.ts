import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { computeGroupConnectTriggerEntry } from '../../../group-state/group-connect-trigger-outbox-entry.ts';
import { serializeCanonicalJson } from '../../../protocol/canonical-json.ts';

export interface PublicationConnectTriggerRequestsInput {
    readonly automationEnabled: boolean;
    readonly target: RallarOverlayTopologySnapshot | null;
    readonly sourceWorkId: string;
    readonly entry: ResourceEntry;
    /** The expiry the attempt decided for the rows it derives. */
    readonly expireAtEpochMs: number;
    readonly traceId: string;
}

export function computePublicationConnectTriggerRequests(
    input: PublicationConnectTriggerRequestsInput
): readonly ResourceEntry[] {
    const { automationEnabled, target, entry } = input;
    if (!automationEnabled || target === null || target.state !== 'active') {
        return [];
    }
    return [computeGroupConnectTriggerEntry({
        work: {
            kind: 'publication',
            groupRef: target.groupRef,
            wakeIdentity: serializeCanonicalJson({
                sourceWorkId: input.sourceWorkId,
                expectedLayout: toGroupLayoutIdentity(target)
            })
        },
        senderId: entry.audit.createdBy,
        createdAtEpochMs: entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
        expireAtEpochMs: input.expireAtEpochMs,
        traceId: input.traceId
    })];
}
