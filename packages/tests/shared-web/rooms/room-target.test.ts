import { expect, it } from 'vitest';

import { toRoomTarget } from '@shared-web/browser/rooms/room-target.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

it('keeps a scoped reference target intact', () => {
    const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

    expect(toRoomTarget(roomRef, {})).toEqual({ roomId: 'room-1', roomRef, options: {} });
});

it.each([undefined, null, 42])('refuses a direct room reference with invalid workspace %s', (workspaceId) => {
    // Browser callers can supply malformed values despite the public TypeScript contract.
    const roomRef = { applicationId: 'app-1', workspaceId, groupId: 'room-1' } as unknown as GroupRef;

    expect(() => toRoomTarget(roomRef, {})).toThrow();
});
