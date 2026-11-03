// @vitest-environment happy-dom
import { RoomModerationPanel } from '@shared-react/room-moderation-panel.tsx';
import type { RoomModerationPanelProps } from '@shared-react/room-moderation-panel.tsx';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { toRallarRoomState } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

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
        expect(fixture.props.entry.cancel).toHaveBeenCalled();
    }
    finally {
        await view.close();
        vi.useRealTimers();
    }
});

it.each(['banned', 'removed'] as const)('explains an authoritative %s roster update before the access timer runs', async (status) => {
    const fixture = createModerationFixture();
    const view = await renderModeration(fixture.props);
    try {
        await act(async () =>
            fixture.publish({
                ...fixture.snapshot,
                members: fixture.snapshot.members.map((member) => member.principalId === 'host' ? { ...member, status } : member),
                activeSessions: []
            }, false)
        );
        expect(view.container.textContent).toContain(`You were ${status}`);
        expect(fixture.props.entry.cancel).toHaveBeenCalledOnce();
    }
    finally {
        await view.close();
    }
});

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
    let listener: Parameters<RoomModerationPanelProps['rooms']['onChange']>[0] | undefined;
    const props: RoomModerationPanelProps = {
        accessCheckIntervalMs: 1000,
        session: { clientId: 'host', sessionId: 'host', username: 'host', accessToken: 'test-token', expiresAtEpochMs: 4_000_000_000_000 },
        entry: { cancel: vi.fn() },
        rooms: {
            session: () => ({ refresh: vi.fn() }),
            state: () => state,
            onChange: (next) => {
                listener = next;
                next(state);
                return () => {
                    listener = undefined;
                };
            },
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
            listener?.(state);
        },
        publish(next: GroupSnapshot, selected = true) {
            state = toRallarRoomState({
                groupSnapshots: [next],
                clientSnapshots: [],
                sessionId: 'host',
                currentRoomRef: selected ? next.group : undefined,
                currentRoom: selected ? next : undefined
            });
            listener?.(state);
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
