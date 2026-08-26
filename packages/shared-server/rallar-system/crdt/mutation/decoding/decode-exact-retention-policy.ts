import type { RallarCrdtRetentionPolicy } from '@shared/crdt/mod.ts';

import {
    requireExactOptionalKeys,
    requireOneOf,
    requirePositiveInteger,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactRetentionPolicy(value: JsonWireValue): RallarCrdtRetentionPolicy {
    const policy = requireCrdtJsonWireObject(value, 'CRDT retention policy');
    requireExactOptionalKeys({
        value: policy,
        required: ['mode'],
        optional: ['ttlMs', 'sensitivePayloads', 'reason'],
        label: 'CRDT retention policy'
    });
    const mode = requireOneOf(
        policy.mode,
        ['retain', 'redact-after', 'delete-after'] as const,
        'retention mode'
    );
    if ('ttlMs' in policy) {
        requirePositiveInteger(policy.ttlMs, 'retention ttlMs');
    }
    if (mode !== 'retain' && !('ttlMs' in policy)) {
        throw new TypeError('CRDT retention ttlMs is required for expiring retention');
    }
    if ('sensitivePayloads' in policy && typeof policy.sensitivePayloads !== 'boolean') {
        throw new TypeError('CRDT retention sensitivePayloads is invalid');
    }
    if ('reason' in policy) {
        requireString(policy.reason, 'retention reason');
    }
    return policy as RallarCrdtRetentionPolicy;
}
