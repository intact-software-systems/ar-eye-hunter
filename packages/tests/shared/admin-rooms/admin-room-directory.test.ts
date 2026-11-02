import {
    describe,
    expect,
    it
} from 'vitest';

import type { AdminRoomDirectoryRequest, AdminRoomDirectoryResponse } from '@shared/api/admin-rooms/admin-room-directory.ts';
import { decodeAdminRoomDirectory } from '@shared/api/admin-rooms/decode-admin-room-directory.ts';

const request: AdminRoomDirectoryRequest = {
    scope: { applicationId: 'ar-eye-hunter', workspaceId: 'default' },
    limit: 2,
    afterGroupId: null
};

function page(): AdminRoomDirectoryResponse {
    return {
        scope: request.scope,
        observedAtEpochMs: 10_000,
        completeness: 'partial',
        nextAfterGroupId: 'b-invalid',
        entries: [{
            status: 'valid',
            room: {
                roomRef: { ...request.scope, groupId: 'a-private' },
                displayName: 'Private arena',
                kind: 'room',
                status: 'active',
                joinMode: 'invite-only',
                directoryListing: 'unlisted',
                activeMemberCount: 1,
                maxMembers: 4,
                expiresAtEpochMs: null
            }
        }, { status: 'invalid', roomRef: { ...request.scope, groupId: 'b-invalid' }, reason: 'invalid-room-record' }]
    };
}

describe('Operator room directory wire contract', () => {
    it('accepts valid summaries beside redacted invalid identities and preserves pagination', () => {
        expect(decodeAdminRoomDirectory(page(), request)).toEqual(page());
        const empty = { ...page(), entries: [], completeness: 'complete', nextAfterGroupId: 'c-deleted' };
        expect(decodeAdminRoomDirectory(empty, request)).toEqual(empty);
    });

    it('rejects foreign scope, duplicate entries and responses that exceed the requested bound', () => {
        const response = page();
        const foreign = { ...request.scope, workspaceId: 'private-other' };
        for (
            const value of [
                { ...response, scope: foreign },
                { ...response, entries: [{ ...response.entries[1], roomRef: { ...foreign, groupId: 'x' } }] },
                { ...response, entries: [response.entries[0], response.entries[0]], completeness: 'complete' },
                { ...response, entries: [...response.entries, response.entries[0]] }
            ]
        ) {
            expect(() => decodeAdminRoomDirectory(value, request)).toThrow();
        }
    });

    it('refuses incomplete, contradictory or payload-bearing diagnostic responses', () => {
        const response = page();
        for (
            const value of [
                { ...response, completeness: 'complete' },
                { ...response, completeness: 'partial', entries: [] },
                { ...response, nextAfterGroupId: undefined },
                { ...response, observedAtEpochMs: -1 },
                { ...response, entries: [{ ...response.entries[1], payload: 'private source' }] },
                { ...response, entries: [{ status: 'valid', room: { roomRef: request.scope } }] }
            ]
        ) {
            expect(() => decodeAdminRoomDirectory(value, request)).toThrow();
        }
    });

    it('refuses a repeated cursor while accepting continuation after omitted storage rows', () => {
        const continued = { ...request, afterGroupId: 'b-invalid' };
        expect(() => decodeAdminRoomDirectory({ ...page(), entries: [], completeness: 'complete' }, continued))
            .toThrow();
        const response = { ...page(), entries: [], completeness: 'complete', nextAfterGroupId: 'c-deleted' };
        expect(decodeAdminRoomDirectory(response, continued)).toEqual(response);
    });
});
