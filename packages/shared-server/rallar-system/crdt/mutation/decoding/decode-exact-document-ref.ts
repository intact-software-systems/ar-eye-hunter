import {
    validateRallarCrdtDocumentRef,
    type RallarCrdtDocumentRef
} from '@shared/crdt/mod.ts';

import { requireExactKeys } from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactDocumentRef(
    value: JsonWireValue,
    label = 'CRDT document'
): RallarCrdtDocumentRef {
    const document = requireCrdtJsonWireObject(value, label);
    const keys = [
        'applicationId',
        'scope',
        'documentType',
        'documentId',
        ...('workspaceId' in document ? ['workspaceId'] : []),
        ...('roomRef' in document ? ['roomRef'] : []),
        ...('principalId' in document ? ['principalId'] : []),
        ...('customScope' in document ? ['customScope'] : [])
    ];
    requireExactKeys(document, keys, label);
    if ('roomRef' in document) {
        const roomRef = requireCrdtJsonWireObject(document.roomRef, `${label} roomRef`);
        requireExactKeys(roomRef, ['applicationId', 'workspaceId', 'groupId'], `${label} roomRef`);
    }
    if (!validateRallarCrdtDocumentRef(document).valid) {
        throw new TypeError(`${label} is invalid`);
    }
    return document as RallarCrdtDocumentRef;
}
