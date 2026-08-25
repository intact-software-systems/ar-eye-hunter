import type { RallarCrdtQuotaPolicy } from '@shared/crdt/mod.ts';

import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    requireExactOptionalKeys,
    requirePositiveInteger
} from '../../../protocol/exact-object-decoding.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactQuotaPolicy(value: JsonWireValue): RallarCrdtQuotaPolicy {
    const policy = requireCrdtJsonWireObject(value, 'CRDT quota policy');
    const keys = [
        'maxUpdateBytes',
        'maxDocumentBytes',
        'maxUpdateCount',
        'maxPendingUpdatesPerReplica',
        'maxUpdatesPerMinutePerActor'
    ];
    requireExactOptionalKeys({
        value: policy,
        required: [],
        optional: keys,
        label: 'CRDT quota policy'
    });
    if (Object.keys(policy).length === 0) {
        throw new TypeError('CRDT quota policy must set a limit');
    }
    for (const key of keys) {
        if (key in policy) {
            requirePositiveInteger(policy[key], `quota ${key}`);
        }
    }
    return policy as RallarCrdtQuotaPolicy;
}
