// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupJoinCodeResponse } from '@shared/api/state-types.ts';
import { ArenaRoomHosting } from '../../../apps/ar-eye-hunter-v1/src/arena-ui/arena-room-hosting.tsx';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

const facade = vi.hoisted(() => ({ session: vi.fn(), rooms: { state: vi.fn(), rotateJoinCode: vi.fn() } }));
vi.mock('@shared-web/browser/rallar.ts', () => ({ rallar: facade }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

it('clears a generated code when the host session changes in the same room', async () => {
    const { session, snapshot, arena } = createHostFixture();
    facade.session.mockReturnValue(session);
    facade.rooms.state.mockReturnValue({ currentRoomRef: snapshot.group });
    facade.rooms.rotateJoinCode.mockResolvedValue({ joinCode: 'session-owned-code', expiresAtEpochMs: 4_000_000_000_000, snapshot });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(ArenaRoomHosting, { arena })));
        const rotate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Rotate room code');
        if (!rotate) {
            throw new Error('The host must be able to rotate the private room code');
        }
        await act(async () => rotate.click());
        expect(container.querySelector('input')?.value).toContain('session-owned-code');
        const replacement = { ...session, sessionId: 'replacement-session' };
        facade.session.mockReturnValue(replacement);
        await act(async () => root.render(createElement(ArenaRoomHosting, { arena: { ...arena, session: replacement } })));
        expect(container.querySelector('input')?.value).toBe('');
        expect(container.textContent).not.toContain('session-owned-code');
    }
    finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it.each(['room', 'session'] as const)('ignores a failed rotation after the host %s changes', async (identity) => {
    const { session, snapshot, arena } = createHostFixture();
    facade.session.mockReturnValue(session);
    facade.rooms.state.mockReturnValue({ currentRoomRef: snapshot.group });
    const rotation = Promise.withResolvers<GroupJoinCodeResponse>();
    facade.rooms.rotateJoinCode.mockReturnValue(rotation.promise);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(ArenaRoomHosting, { arena })));
        const rotate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Rotate room code');
        if (!rotate) {
            throw new Error('The host must be able to rotate the private room code');
        }
        await act(async () => rotate.click());
        const nextSession = identity === 'session' ? { ...session, sessionId: 'replacement-session' } : session;
        const nextGroup = { ...snapshot.group, groupId: identity === 'room' ? 'another-arena' : snapshot.group.groupId };
        facade.session.mockReturnValue(nextSession);
        facade.rooms.state.mockReturnValue({ currentRoomRef: nextGroup });
        await act(async () =>
            root.render(createElement(ArenaRoomHosting, {
                arena: {
                    ...arena,
                    session: nextSession,
                    roomId: nextGroup.groupId,
                    rooms: [{ ...arena.rooms[0], roomId: nextGroup.groupId, roomRef: nextGroup, snapshot: { ...snapshot, group: nextGroup } }]
                }
            }))
        );
        await act(async () => rotation.reject(new Error('The previous room rotation failed')));
        expect(container.querySelector('[role="alert"]')).toBeNull();
        const create = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New unlisted arena');
        expect(create?.disabled).toBe(false);
    }
    finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('keeps rotation disabled while creation publishes its initial code', async () => {
    const { session, snapshot, arena } = createHostFixture();
    const created = { ...snapshot, group: { ...snapshot.group, groupId: 'created-arena' } };
    facade.session.mockReturnValue(session);
    facade.rooms.state.mockReturnValue({ currentRoomRef: snapshot.group });
    const rotation = Promise.withResolvers<GroupJoinCodeResponse>();
    facade.rooms.rotateJoinCode.mockReturnValue(rotation.promise);
    const creating = {
        ...arena,
        createArenaRoom: async () => {
            facade.rooms.state.mockReturnValue({ currentRoomRef: created.group });
            return created;
        }
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(ArenaRoomHosting, { arena: creating })));
        const create = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New code arena');
        if (!create) {
            throw new Error('The host must be able to create a code arena');
        }
        await act(async () => create.click());
        await act(async () =>
            root.render(createElement(ArenaRoomHosting, {
                arena: {
                    ...creating,
                    roomId: created.group.groupId,
                    rooms: [{ ...arena.rooms[0], roomId: created.group.groupId, roomRef: created.group, snapshot: created }]
                }
            }))
        );
        const rotate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Rotate room code');
        expect(rotate?.disabled).toBe(true);
        await act(async () => rotation.resolve({ joinCode: 'initial-code', expiresAtEpochMs: 4_000_000_000_000, snapshot: created }));
        expect(rotate?.disabled).toBe(false);
        expect(container.querySelector('input')?.value).toContain('initial-code');
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
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId: 'private-arena',
        sessionIds: ['host']
    });
    const snapshot = { ...room, group: { ...room.group, joinMode: 'code' as const } };
    const arena: ComponentProps<typeof ArenaRoomHosting>['arena'] = {
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
    return { session, snapshot, arena };
}
