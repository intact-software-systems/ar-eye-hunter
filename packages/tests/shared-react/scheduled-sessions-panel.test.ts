// @vitest-environment happy-dom
import { ScheduledSessionsPanel, type ScheduledSessionsPanelProps } from '@shared-react/scheduled-sessions-panel.tsx';
import { toGroupSessionTiming } from '@shared/api/group-sessions/group-session-schedule.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

it('renders explicit reservation and lobby controls from the current account preview', async () => {
    const schedule = { revision: 1, startsAtEpochMs: 3_600_000, cancelledAtEpochMs: null };
    const state = {
        sessions: [],
        hasMore: false,
        busy: false,
        retryPending: false,
        error: null,
        selected: {
            roomRef: { applicationId: 'game', workspaceId: 'default', groupId: 'friday' },
            displayName: 'Friday',
            schedule,
            timing: toGroupSessionTiming(schedule, 1_000),
            serverNowEpochMs: 1_000,
            maxPlayers: 4,
            availableSeats: 3,
            participation: 'none' as const,
            isOrganizer: false,
            canReserve: true,
            canEnter: false,
            admissionDenial: null
        }
    };
    const owner: ScheduledSessionsPanelProps['owner'] = {
        getState: () => state,
        onChange: () => () => {},
        start: vi.fn(async () => {}),
        stop: vi.fn(),
        refresh: vi.fn(async () => {}),
        loadMore: vi.fn(async () => {}),
        select: vi.fn(async () => {}),
        create: vi.fn(async () => {}),
        act: vi.fn(async () => {}),
        retry: vi.fn(async () => {}),
        enterLobby: vi.fn(async () => {})
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(ScheduledSessionsPanel, { owner, connected: true, defaultName: 'Arena session', maxPlayers: 4 })));
        const reserve = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reserve a seat');
        const enter = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Enter lobby');
        expect(reserve?.disabled).toBe(false);
        expect(enter?.disabled).toBe(true);
        await act(async () => reserve?.click());
        expect(owner.act).toHaveBeenCalledWith('reserve');
        expect(owner.enterLobby).not.toHaveBeenCalled();
        expect(container.querySelector<HTMLInputElement>('input[aria-label="Session share link"]')?.value).toContain('#rallar-session?');
        expect(container.textContent).toContain('Lobby opens');
        expect(container.textContent).toContain('Time zone');
    }
    finally {
        await act(async () => root.unmount());
        container.remove();
    }
    expect(owner.stop).toHaveBeenCalledOnce();
});
