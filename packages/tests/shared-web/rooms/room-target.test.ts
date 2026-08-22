import { expect, it } from 'vitest';

it('exposes the owning room target translation', async () => {
    const { toRoomTarget } = await import('@shared-web/browser/rooms/room-target.ts');
    expect(typeof toRoomTarget).toBe('function');
});

it('keeps a scoped reference target intact', async () => {
    const { toRoomTarget } = await import('@shared-web/browser/rooms/room-target.ts');
    const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

    expect(toRoomTarget(roomRef, {})).toEqual({ roomId: 'room-1', roomRef, options: {} });
});
