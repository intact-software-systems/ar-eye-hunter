// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';
import { createGroupSnapshotFixture } from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';
import { RelicRoomHosting } from '../src/game/hud/relic-room-hosting.tsx';

const facade = vi.hoisted(() => ({ session: vi.fn(), rooms: { state: vi.fn(), rotateJoinCode: vi.fn() } }));
vi.mock('@shared-web/browser/rallar.ts', () => ({ rallar: facade }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['success', 'failure'] as const)('ignores a superseded rotation %s after hosting another room and returning', async (outcome) => {
    const { session, snapshot, game } = createHostFixture();
    const other = { ...snapshot, group: { ...snapshot.group, groupId: 'another-expedition' } };
    facade.session.mockReturnValue(session);
    facade.rooms.state.mockReturnValue({ currentRoomRef: snapshot.group });
    const oldRotation = Promise.withResolvers<GroupJoinCodeResponse>();
    facade.rooms.rotateJoinCode.mockReturnValueOnce(oldRotation.promise);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(RelicRoomHosting, { game })));
        const rotate = () => {
            const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Rotate room code');
            if (!button) {
                throw new Error('The host must be able to rotate the room code');
            }
            expect(button.disabled).toBe(false);
            button.click();
        };
        await act(async () => rotate());
        for (const current of [other, snapshot]) {
            facade.rooms.state.mockReturnValue({ currentRoomRef: current.group });
            facade.rooms.rotateJoinCode.mockResolvedValueOnce({ joinCode: 'latest-code', expiresAtEpochMs: 4_000_000_000_000, snapshot: current });
            await act(async () =>
                root.render(createElement(RelicRoomHosting, {
                    game: {
                        ...game,
                        roomId: current.group.groupId,
                        rooms: [{ ...game.rooms[0], roomId: current.group.groupId, roomRef: current.group, snapshot: current }]
                    }
                }))
            );
            await act(async () => rotate());
        }
        expect(container.querySelector('input')?.value).toContain('latest-code');
        await act(async () => {
            if (outcome === 'success') {
                oldRotation.resolve({ joinCode: 'obsolete-code', expiresAtEpochMs: 4_000_000_000_000, snapshot });
            }
            else {
                oldRotation.reject(new Error('The obsolete rotation failed'));
            }
        });
        expect(container.querySelector('input')?.value).toContain('latest-code');
        expect(container.querySelector('[role="alert"]')).toBeNull();
    }
    finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

function createHostFixture() {
    const session: AuthSession = {
        clientId: 'host',
        sessionId: 'host-session',
        username: 'Host',
        accessToken: 'fixture-token',
        expiresAtEpochMs: 4_000_000_000_000
    };
    const room = createGroupSnapshotFixture({
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'private-expedition',
        sessionIds: ['host']
    });
    const snapshot = { ...room, group: { ...room.group, joinMode: 'code' as const } };
    const game: ComponentProps<typeof RelicRoomHosting>['game'] = {
        session,
        roomId: snapshot.group.groupId,
        createRoom: async () => snapshot,
        diagnostics: { middlewareConnected: true },
        rooms: [{
            roomId: snapshot.group.groupId,
            roomRef: snapshot.group,
            name: 'Private expedition',
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
    return { session, snapshot, game };
}
