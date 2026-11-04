// @vitest-environment happy-dom
import { RoomModerationPanel } from '@shared-react/room-moderation-panel.tsx';
import type { RoomModerationPanelProps } from '@shared-react/room-moderation-panel.tsx';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import { toRallarRoomState } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { createRevokedGroupMember } from '../shared-web/create-revoked-group-member.ts';

it('subscribes safely before room repositories are initialized', async () => {
    const fixture = createModerationFixture();
    fixture.props.rooms.state = () => {
        throw new Error('Repository not found');
    };
    fixture.props.rooms.onChange = () => () => undefined;
    const view = await renderModeration(fixture.props);
    try {
        expect(view.container.querySelectorAll('button')).toHaveLength(0);
    }
    finally {
        await view.close();
    }
});

it('requires confirmation and reports a ban only after the server accepts it', async () => {
    const fixture = createModerationFixture();
    const response = Promise.withResolvers<GroupSnapshot>();
    fixture.props.rooms.banMember = async () => response.promise;
    const view = await renderModeration(fixture.props);
    try {
        await click(view.container, 'Ban guest');
        expect(view.container.textContent).toContain('Confirm ban');
        expect(view.container.textContent).not.toContain('guest was banned');
        await click(view.container, 'Confirm ban');
        expect(button(view.container, 'Confirm ban').disabled).toBe(true);
        await act(async () => response.resolve(fixture.snapshot));
        expect(view.container.textContent).toContain('guest was banned');
    }
    finally {
        await view.close();
    }
});

it('hides moderation from regular players and never offers self or owner removal', async () => {
    const fixture = createModerationFixture();
    const view = await renderModeration(fixture.props);
    try {
        expect([...view.container.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual(['Remove guest', 'Ban guest']);
        await act(async () =>
            view.root.render(createElement(RoomModerationPanel, {
                ...fixture.props,
                session: { ...fixture.props.session, clientId: 'guest', sessionId: 'guest-session' }
            }))
        );
        expect(view.container.querySelectorAll('button')).toHaveLength(0);
    }
    finally {
        await view.close();
    }
});

it('allows an administrator to moderate spectators but not other administrators or owners', async () => {
    const fixture = createModerationFixture();
    fixture.publish({
        ...fixture.snapshot,
        members: [
            { ...fixture.snapshot.members[0], role: 'admin' },
            { ...fixture.snapshot.members[1], role: 'spectator' },
            { ...fixture.snapshot.members[1], principalId: 'other-admin', role: 'admin' },
            { ...fixture.snapshot.members[1], principalId: 'owner', role: 'owner' }
        ]
    });
    const view = await renderModeration(fixture.props);
    try {
        expect([...view.container.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual(['Remove guest', 'Ban guest']);
    }
    finally {
        await view.close();
    }
});

it('retains a failed confirmation for an explicit retry without reporting success', async () => {
    const fixture = createModerationFixture();
    fixture.props.rooms.banMember = vi.fn().mockRejectedValueOnce(new Error('Admission changed')).mockResolvedValue(fixture.snapshot);
    const view = await renderModeration(fixture.props);
    try {
        await click(view.container, 'Ban guest');
        await click(view.container, 'Confirm ban');
        expect(view.container.textContent).toContain('Admission changed');
        expect(view.container.textContent).not.toContain('was banned');
        await click(view.container, 'Confirm ban');
        expect(view.container.textContent).toContain('guest was banned');
        expect(view.container.textContent).not.toContain('Admission changed');
    }
    finally {
        await view.close();
    }
});

it('discards an old confirmation and delayed outcome when the selected room changes', async () => {
    const fixture = createModerationFixture();
    const response = Promise.withResolvers<GroupSnapshot>();
    fixture.props.rooms.banMember = async () => response.promise;
    const view = await renderModeration(fixture.props);
    try {
        await click(view.container, 'Ban guest');
        await click(view.container, 'Confirm ban');
        const next = { ...fixture.snapshot, group: { ...fixture.snapshot.group, groupId: 'other-room' } };
        await act(async () => fixture.publish(next));
        await act(async () => response.resolve(fixture.snapshot));
        expect(view.container.textContent).not.toContain('was banned');
        expect(view.container.textContent).not.toContain('Confirm ban');
    }
    finally {
        await view.close();
    }
});

it.each(['member-banned', 'member-removed'])('clears access after the current-room read reports %s', async (code) => {
    vi.useFakeTimers();
    const fixture = createModerationFixture();
    fixture.props.rooms.session = () => ({
        refresh: vi.fn(async () => {
            fixture.clearSelection();
            throw new ApiHttpError('GET', '/group', 403, JSON.stringify({ error: 'forbidden', code }));
        })
    });
    const view = await renderModeration(fixture.props);
    try {
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(view.container.textContent).toContain(code === 'member-banned' ? 'You were banned' : 'You were removed');
    }
    finally {
        await view.close();
        vi.useRealTimers();
    }
});

it.each(['member-banned', 'member-removed'])('explains %s when collection repair drops the room before the access timer', async (code) => {
    const fixture = createModerationFixture();
    fixture.props.rooms.session = () => ({
        refresh: vi.fn().mockRejectedValue(new ApiHttpError('GET', '/group', 403, JSON.stringify({ error: 'forbidden', code })))
    });
    const view = await renderModeration(fixture.props);
    try {
        await act(async () => fixture.clearSelection());
        expect(view.container.textContent).toContain(code === 'member-banned' ? 'You were banned' : 'You were removed');
    }
    finally {
        await view.close();
    }
});

it('does not label a cache gap as removal when the authenticated room read succeeds', async () => {
    const fixture = createModerationFixture();
    const refresh = vi.fn().mockResolvedValue(undefined);
    fixture.props.rooms.session = () => ({ refresh });
    const view = await renderModeration(fixture.props);
    try {
        await act(async () => fixture.clearSelection());
        expect(view.container.textContent).not.toContain('You were');
    }
    finally {
        await view.close();
    }
});

it('ignores a departed-room access result after a newer room has also been cleared', async () => {
    const fixture = createModerationFixture();
    const response = Promise.withResolvers<never>();
    fixture.props.rooms.session = (room) => ({
        refresh: () =>
            room.groupId === fixture.snapshot.group.groupId ? response.promise : Promise.reject(new ApiHttpError('GET', '/next-room', 503, 'unavailable'))
    });
    const view = await renderModeration(fixture.props);
    try {
        await act(async () => fixture.clearSelection());
        await act(async () => fixture.publish({ ...fixture.snapshot, group: { ...fixture.snapshot.group, groupId: 'next-room' } }));
        await act(async () => fixture.clearSelection());
        await act(async () => response.reject(new ApiHttpError('GET', '/old-room', 403, JSON.stringify({ error: 'forbidden', code: 'member-removed' }))));
        expect(view.container.textContent).not.toContain('You were');
    }
    finally {
        await view.close();
    }
});

it('cancels a pending access check before disposing its room state on unmount', async () => {
    const fixture = createModerationFixture();
    const response = Promise.withResolvers<never>();
    const started = Promise.withResolvers<AbortSignal | undefined>();
    fixture.props.rooms.session = () => ({
        refresh: (options) => {
            started.resolve(options?.signal);
            return response.promise;
        }
    });
    const view = await renderModeration(fixture.props);
    await act(async () => fixture.clearSelection());
    const signal = await started.promise;
    await view.close();
    fixture.props.rooms.state = () => {
        throw new Error('Room state disposed');
    };
    await act(async () => response.reject(new ApiHttpError('GET', '/old-room', 403, JSON.stringify({ error: 'forbidden', code: 'member-removed' }))));
    expect(signal?.aborted).toBe(true);
});

it.each(['banned', 'removed'] as const)('explains an authoritative %s roster update before the access timer runs', async (status) => {
    const fixture = createModerationFixture();
    const view = await renderModeration(fixture.props);
    try {
        await act(async () =>
            fixture.publish({
                ...fixture.snapshot,
                members: fixture.snapshot.members.map((member) => member.principalId === 'host' ? createRevokedGroupMember(member, status) : member),
                activeSessions: []
            }, false)
        );
        expect(view.container.textContent).toContain(`You were ${status}`);
    }
    finally {
        await view.close();
    }
});

it.each(['read', 'roster'] as const)('preserves a newer admission when an obsolete %s reports revocation', async (delivery) => {
    vi.useFakeTimers();
    const fixture = createModerationFixture();
    const response = Promise.withResolvers<never>();
    fixture.props.rooms.session = () => ({ refresh: () => response.promise });
    const joining = Promise.withResolvers<GroupSnapshot>();
    const entry = createRoomEntry(fixture.props, (room) => room.groupId === 'next-room' ? joining.promise : Promise.resolve(fixture.snapshot));
    entry.start();
    await entry.resume();
    const view = await renderModeration(fixture.props);
    try {
        expect(entry.getState().status).toBe('entered');
        if (delivery === 'read') {
            await act(async () => vi.advanceTimersByTimeAsync(1000));
            await act(async () => fixture.clearSelection());
            expect(entry.getState().status).toBe('idle');
        }
        const next = { ...fixture.snapshot, group: { ...fixture.snapshot.group, groupId: 'next-room' } };
        entry.enter({ intent: 'join', roomRef: next.group, joinCode: null, participation: 'player' });
        const admission = entry.resume();
        await act(async () => {
            if (delivery === 'read') {
                response.reject(new ApiHttpError('GET', '/old-room', 403, JSON.stringify({ error: 'forbidden', code: 'member-banned' })));
            }
            else {
                fixture.publish({
                    ...fixture.snapshot,
                    activeSessions: [],
                    members: fixture.snapshot.members.map((member) => createRevokedGroupMember(member, 'banned'))
                }, false);
            }
        });
        expect(entry.getState().status).toBe('joining');
        joining.resolve(next);
        await admission;
        expect(entry.getState()).toMatchObject({ status: 'entered', destination: { roomRef: { groupId: 'next-room' } } });
    }
    finally {
        entry.stop();
        await view.close();
        vi.useRealTimers();
    }
});

function createRoomEntry(props: RoomModerationPanelProps, join: (room: GroupRef) => Promise<GroupSnapshot>): RallarRoomEntry {
    const storage = new Map<string, string>();
    return new RallarRoomEntry({
        auth: { session: () => props.session, onChange: () => () => undefined },
        rooms: { onChange: props.rooms.onChange, join },
        storage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => {
                storage.set(key, value);
            },
            removeItem: (key) => {
                storage.delete(key);
            }
        },
        location: { read: () => 'https://game.example/', replace: () => undefined, onChange: () => () => undefined }
    }, { scope: { applicationId: 'game', workspaceId: 'default' } });
}

it('does not treat a failed access read as revocation', async () => {
    vi.useFakeTimers();
    const fixture = createModerationFixture();
    fixture.props.rooms.session = () => ({ refresh: vi.fn().mockRejectedValue(new ApiHttpError('GET', '/group', 503, 'unavailable')) });
    const view = await renderModeration(fixture.props);
    try {
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(view.container.textContent).not.toContain('You were');
        expect(button(view.container, 'Ban guest').disabled).toBe(false);
    }
    finally {
        await view.close();
        vi.useRealTimers();
    }
});

function createModerationFixture() {
    const snapshot = createGroupSnapshotFixture({ applicationId: 'game', workspaceId: 'default', groupId: 'room', sessionIds: ['host', 'guest'] });
    let state = toRallarRoomState({
        groupSnapshots: [snapshot],
        clientSnapshots: [],
        sessionId: 'host',
        currentRoomRef: snapshot.group,
        currentRoom: snapshot
    });
    const notifications = new SynchronousNotifications<RallarRoomState>((error) => {
        throw error;
    });
    const props: RoomModerationPanelProps = {
        accessCheckIntervalMs: 1000,
        session: { clientId: 'host', sessionId: 'host', username: 'host', accessToken: 'test-token', expiresAtEpochMs: 4_000_000_000_000 },
        rooms: {
            session: () => ({ refresh: vi.fn() }),
            state: () => state,
            onChange: (listener) => notifications.subscribeAndNotify(listener, state).unsubscribe,
            removeMember: async () => snapshot,
            banMember: async () => snapshot,
            unbanMember: async () => snapshot
        }
    };
    return {
        props,
        snapshot,
        clearSelection() {
            state = toRallarRoomState({ groupSnapshots: [], clientSnapshots: [], sessionId: 'host' });
            notifications.publishLatest(state);
        },
        publish(next: GroupSnapshot, selected = true) {
            state = toRallarRoomState({
                groupSnapshots: [next],
                clientSnapshots: [],
                sessionId: 'host',
                currentRoomRef: selected ? next.group : undefined,
                currentRoom: selected ? next : undefined
            });
            notifications.publishLatest(state);
        }
    };
}

async function renderModeration(props: RoomModerationPanelProps) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(StrictMode, null, createElement(RoomModerationPanel, props))));
    return {
        container,
        root,
        async close() {
            await act(async () => root.unmount());
            container.remove();
        }
    };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((entry) => entry.textContent === name);
    if (!found) {
        throw new Error(`Missing button: ${name}`);
    }
    return found;
}

async function click(container: HTMLElement, name: string): Promise<void> {
    await act(async () => button(container, name).click());
}
