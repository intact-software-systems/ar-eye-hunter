import { describe, expect, it } from 'vitest';

import {
    decodeGroupStateChildStorageKey,
    groupStateGroupStorageKey
} from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';
import { PUBLICATION_GRANTS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { canonicalStoredPublicationGrant } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-codec.ts';
import { groupStatePublicationGrantStorageKey } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-storage-key.ts';
import { groupStateUpdatePublicationGrantDescriptor } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-write-descriptors.ts';
import { encodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { GroupPublicationGrant } from '@shared/api/group-publication/group-publication-grants.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { groupRef, storedEntry } from '../mutation/group-mutation-test-runtime.ts';

const REF = groupRef('pure-room');

function grantFor(principalId: string): GroupPublicationGrant {
    return {
        ...REF,
        principalId,
        topics: { 'room.feed': { publish: true, subscribe: true } },
        updated: {
            atEpochMs: 1_000,
            actor: { kind: 'principal', principalId: 'alice' },
            reason: null,
            traceId: null,
            requestId: 'grant-request-000000001'
        }
    };
}

describe('group publication grant storage', () => {
    it('the key is <groupKey>:grant=<principalId> and decodes at arity 4', () => {
        const key = groupStatePublicationGrantStorageKey(REF, 'bob');

        expect(PUBLICATION_GRANTS_NAMESPACE).toBe('group-state:publication-grants');
        expect(key).toBe(`${groupStateGroupStorageKey(REF)}:grant=bob`);
        expect(decodeGroupStateChildStorageKey(key, 'grant', 'principalId')).toEqual({ ...REF, principalId: 'bob' });
    });

    it('a row whose principal differs from its key is corruption', () => {
        const stored = storedEntry(groupStatePublicationGrantStorageKey(REF, 'bob'), encodeJsonWireValue(grantFor('carol')));

        expect(() => canonicalStoredPublicationGrant(stored, REF)).toThrow(GroupStateRepositoryInvariantCorruptionError);
        expect(
            canonicalStoredPublicationGrant(
                storedEntry(groupStatePublicationGrantStorageKey(REF, 'carol'), encodeJsonWireValue(grantFor('carol'))),
                REF
            ).value
        ).toEqual(grantFor('carol'));
    });

    it('the put descriptor never expires and carries expectedRevision', () => {
        expect(groupStateUpdatePublicationGrantDescriptor(grantFor('bob'), 3)).toEqual({
            operation: 'update',
            namespace: PUBLICATION_GRANTS_NAMESPACE,
            key: groupStatePublicationGrantStorageKey(REF, 'bob'),
            value: JSON.stringify(grantFor('bob')),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision: 3
        });
    });
});
