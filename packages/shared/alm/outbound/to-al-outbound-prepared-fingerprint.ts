import { fnv1a64 } from '../../queuebox/AppQueueIdentity.ts';
import { stableJsonStringify } from '../../repository/state-utils.ts';

export function toALOutboundPreparedFingerprint<TPrepared>(prepared: TPrepared): string {
    return fnv1a64(stableJsonStringify(prepared));
}
