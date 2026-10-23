// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { AuthSession } from '@shared/api/api-config.ts';
import { ArenaPrivateRooms } from '../../../apps/ar-eye-hunter-v1/src/arena-ui/arena-private-rooms.tsx';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const facade = vi.hoisted(() => ({ session: vi.fn(), rooms: { state: vi.fn(), rotateJoinCode: vi.fn() } }));
vi.mock('@shared-web/browser/rallar.ts', () => ({ rallar: facade }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

it('clears a generated code when the host session changes in the same room', async () => {
    const session: AuthSession = {
        clientId: 'host',
        sessionId: 'host-session',
        username: 'Host',
        accessToken: 'fixture-token',
        expiresAtEpochMs: 4_000_000_000_000
    };
    const room = createGroupSnapshotFixture({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId: 'private-arena',
        sessionIds: ['host']
    });
    const snapshot = { ...room, group: { ...room.group, joinMode: 'code' as const } };
    const arena: ComponentProps<typeof ArenaPrivateRooms>['arena'] = {
        session,
        roomId: 'private-arena',
        createArenaRoom: async () => snapshot,
        rooms: [{
            roomId: 'private-arena',
            roomRef: snapshot.group,
            name: 'Private arena',
            status: 'active',
            kind: 'room',
            joinMode: 'code',
            memberCount: 1,
            onlineMemberCount: 1,
            isJoined: true,
            isCurrent: true,
            snapshot
        }]
    };
    facade.session.mockReturnValue(session);
    facade.rooms.state.mockReturnValue({ currentRoomRef: snapshot.group });
    facade.rooms.rotateJoinCode.mockResolvedValue({ joinCode: 'session-owned-code', expiresAtEpochMs: 4_000_000_000_000, snapshot });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(ArenaPrivateRooms, { arena })));
        const rotate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Rotate room code');
        if (!rotate) {
            throw new Error('The host must be able to rotate the private room code');
        }
        await act(async () => rotate.click());
        expect(container.querySelector('input')?.value).toContain('session-owned-code');
        const replacement = { ...session, sessionId: 'replacement-session' };
        facade.session.mockReturnValue(replacement);
        await act(async () => root.render(createElement(ArenaPrivateRooms, { arena: { ...arena, session: replacement } })));
        expect(container.querySelector('input')?.value).toBe('');
        expect(container.textContent).not.toContain('session-owned-code');
    }
    finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
