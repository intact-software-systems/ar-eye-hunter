import { describe, expect, it } from 'vitest';

import { decodeExactGroupRef } from '@shared/api/decode-exact-group-ref.ts';

const GROUP_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

describe('decodeExactGroupRef', () => {
    it('returns a fresh copy of an exact group reference', () => {
        const source = { ...GROUP_REF };
        const decoded = decodeExactGroupRef(source, 'Stored row');

        expect(decoded).toEqual(GROUP_REF);
        expect(decoded).not.toBe(source);
    });

    it.each<[string, unknown, string]>([
        ['no object', 'room-1', 'Stored row groupRef must be an exact object'],
        ['an extra key', { ...GROUP_REF, extra: 1 }, 'Stored row groupRef fields are invalid'],
        ['a missing key', { applicationId: 'app-1', workspaceId: 'workspace-1' }, 'Stored row groupRef fields are invalid'],
        ['an empty id', { ...GROUP_REF, workspaceId: '' }, 'Stored row workspaceId must be a non-empty string'],
        ['a non-string id', { ...GROUP_REF, groupId: 7 }, 'Stored row groupId must be a non-empty string']
    ])('throws on %s, naming the label', (_case, value, message) => {
        expect(() => decodeExactGroupRef(value, 'Stored row')).toThrow(new TypeError(message));
    });
});
