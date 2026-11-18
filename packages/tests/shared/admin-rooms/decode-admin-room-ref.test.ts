import { describe, expect, it } from 'vitest';

import { decodeAdminRoomRef } from '@shared/api/admin-rooms/decode-admin-room-ref.ts';

const ROOM_REF = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room-1' };

describe('decodeAdminRoomRef', () => {
    it('decodes a room identity into its canonical field order', () => {
        const decoded = decodeAdminRoomRef({ groupId: 'room-1', workspaceId: 'default', applicationId: 'ar-eye-hunter' });

        expect(decoded.right).toEqual(ROOM_REF);
        expect(Object.keys(decoded.right ?? {})).toEqual(['applicationId', 'workspaceId', 'groupId']);
    });

    it('refuses a missing or extra field and a field that is not a route ID', () => {
        const { workspaceId: _workspaceId, ...withoutWorkspace } = ROOM_REF;
        const refused = [
            null,
            withoutWorkspace,
            { ...ROOM_REF, extra: 'x' },
            { ...ROOM_REF, groupId: '' },
            { ...ROOM_REF, groupId: ' room-1' },
            { ...ROOM_REF, applicationId: 7 }
        ];

        for (const value of refused) {
            expect(decodeAdminRoomRef(value).left).toBeDefined();
        }
    });
});
