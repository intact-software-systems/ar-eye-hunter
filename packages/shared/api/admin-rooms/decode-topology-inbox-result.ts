import { decodeExactGroupRef } from '../decode-exact-group-ref.ts';
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
    const groupRef = decodeExactGroupRef(result.groupRef, 'Topology AppInbox');
    requireString(result.requestId, 'Topology reconfigure requestId');
    requireString(result.outboxId, 'Topology reconfigure outboxId');
    return { status: 'queued', groupRef, requestId: result.requestId, outboxId: result.outboxId };
}
