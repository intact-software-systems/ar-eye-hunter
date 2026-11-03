import { requireExactKeys, requireRecord, requireString } from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';

export interface TopologyReconfigureInboxResult {
    readonly status: 'queued';
    readonly groupRef: GroupRef;
    readonly requestId: string;
    readonly outboxId: string;
}

export function decodeTopologyReconfigureInboxResult(
    value: unknown
): TopologyReconfigureInboxResult {
    const result = requireRecord(value, 'Topology reconfigure AppInbox result');
    requireExactKeys(
        result,
        ['status', 'groupRef', 'requestId', 'outboxId'],
        'Topology reconfigure AppInbox result'
    );
    if (result.status !== 'queued') {
        throw new TypeError('Topology reconfigure status is invalid');
    }
    const groupRef = decodeExactGroupRef(result.groupRef);
    requireString(result.requestId, 'Topology reconfigure requestId');
    requireString(result.outboxId, 'Topology reconfigure outboxId');
    return { status: 'queued', groupRef, requestId: result.requestId, outboxId: result.outboxId };
}

export function decodeExactGroupRef(value: unknown): TopologyReconfigureInboxResult['groupRef'] {
    const groupRef = requireRecord(value, 'Topology AppInbox groupRef');
    requireExactKeys(
        groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Topology AppInbox groupRef'
    );
    requireString(groupRef.applicationId, 'Topology AppInbox applicationId');
    requireString(groupRef.workspaceId, 'Topology AppInbox workspaceId');
    requireString(groupRef.groupId, 'Topology AppInbox groupId');
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}
