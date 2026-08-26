import type { RallarCrdtTrustedAppendMetadata } from '@shared/crdt/mod.ts';

import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requirePositiveInteger,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactTrustedAppendMetadata(value: JsonWireValue): RallarCrdtTrustedAppendMetadata {
    const append = requireCrdtJsonWireObject(value, 'CRDT append metadata');
    requireExactKeys(
        append,
        [
            'appendSequence',
            'acceptedAtEpochMs',
            'actorId',
            'principalId',
            'sessionId',
            'serverId',
            'authorizationScope',
            'acceptedUpdateHash'
        ],
        'CRDT append metadata'
    );
    requirePositiveInteger(append.appendSequence, 'append sequence');
    requireEpoch(append.acceptedAtEpochMs, 'append acceptedAtEpochMs');
    for (const field of ['actorId', 'principalId', 'sessionId', 'serverId', 'acceptedUpdateHash']) {
        requireString(append[field], `append ${field}`);
    }
    requireOneOf(
        append.authorizationScope,
        ['room', 'principal', 'app', 'custom'] as const,
        'append authorizationScope'
    );
    return append as RallarCrdtTrustedAppendMetadata;
}
