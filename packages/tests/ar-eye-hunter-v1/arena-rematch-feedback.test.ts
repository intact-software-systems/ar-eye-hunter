// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';
import {
    arenaMembershipSnapshot,
    ArenaRuntimeTestHarness,
    freshDirectorStatus,
    session
} from './arena-runtime-test-harness.ts';

import type { ArenaMatchState } from '@ar-eye-hunter/arena-contracts.ts';
import { MatchWinnerOverlay } from '../../../apps/ar-eye-hunter-v1/src/arena-ui/match-winner-overlay.tsx';
import type { ArenaConnection } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/arena-connection-contracts.ts';

const runtime = new ArenaRuntimeTestHarness();
let container: HTMLDivElement;
let root: Root;
let arena: ArenaConnection;
const completed: ArenaMatchState = {
    matchId: 'finished-match',
    status: 'complete',
    enrollment: 'open',
    durationMs: 60_000,
    directorSessionId: session.sessionId,
    startedAtEpochMs: 1,
    endsAtEpochMs: 60_001,
    baseline: { [session.sessionId]: { sessionId: session.sessionId, username: 'Hunter', score: 0, kills: 0, deaths: 0, joinedOrder: 0 } }
};

beforeEach(async () => {
    runtime.reset();
    await runtime.render();
    if (!runtime.current) {
        throw new Error('The arena runtime did not mount');
    }
    const snapshot = arenaMembershipSnapshot();
    arena = {
        ...runtime.current,
        directorStatus: freshDirectorStatus(),
        rooms: [{
            roomId: 'arena-1',
            roomRef: snapshot.group,
            name: 'Arena',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            memberCount: 1,
            onlineMemberCount: 1,
            isJoined: true,
            isCurrent: true,
            snapshot
        }],
        setRematchReady: async () => undefined
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(MatchWinnerOverlay, { match: completed, arena, onReturnToBracket: () => {} })));
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    await runtime.dispose();
});

it('does not treat a delivered command as confirmation and offers retry when no result arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => button('Play again').click());
    expect(button('Play again').disabled).toBe(true);
    expect(container.textContent).toContain('Waiting for the director');
    await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(button('Play again').disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/not confirmed.*try again/i);
    expect(container.textContent).toContain('waiting');
});

it('finishes only when the current membership confirmation is visible, and cancels its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => button('Play again').click());
    expect(button('Play again').disabled).toBe(true);
    const member = arena.rooms[0].snapshot.members.find((entry) => entry.principalId === session.clientId)!;
    const participationKey = JSON.stringify([
        member.applicationId,
        member.workspaceId,
        member.groupId,
        member.principalId,
        member.role,
        member.updated.atEpochMs,
        member.updated.requestId,
        member.updated.traceId
    ]);
    const confirmed: ArenaMatchState = {
        ...completed,
        rematch: {
            durationMs: 60_000,
            preparation: {
                completedGameId: 'finished-match',
                settingsKey: 'duration:60000:0',
                players: [{ sessionId: session.sessionId, ready: true, participationKey }]
            }
        }
    };
    await act(async () => root.render(createElement(MatchWinnerOverlay, { match: confirmed, arena, onReturnToBracket: () => {} })));
    expect(button('Cancel ready').disabled).toBe(false);
    await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('ignores a late delivery failure after the player explicitly retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = Promise.withResolvers<void>();
    arena = { ...arena, setRematchReady: () => first.promise };
    await act(async () => root.render(createElement(MatchWinnerOverlay, { match: completed, arena, onReturnToBracket: () => {} })));
    await act(async () => button('Play again').click());
    await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(button('Play again').disabled).toBe(false);
    arena = { ...arena, setRematchReady: async () => undefined };
    await act(async () => root.render(createElement(MatchWinnerOverlay, { match: completed, arena, onReturnToBracket: () => {} })));
    await act(async () => button('Play again').click());
    await act(async () => first.reject(new Error('An obsolete send failed')));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button('Play again').disabled).toBe(true);
});

it('shows the director refusal inside the results controls and lets the player retry', async () => {
    await act(async () => button('Play again').click());
    arena = { ...arena, error: 'The next match settings changed. Confirm again.' };
    await act(async () => root.render(createElement(MatchWinnerOverlay, { match: completed, arena, onReturnToBracket: () => {} })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('settings changed');
    expect(button('Play again').disabled).toBe(false);
});

it('reports lost participation instead of silently resetting an in-flight confirmation', async () => {
    await act(async () => button('Play again').click());
    arena = { ...arena, roomId: undefined, rooms: [] };
    await act(async () => root.render(createElement(MatchWinnerOverlay, { match: completed, arena, onReturnToBracket: () => {} })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('participation changed');
});

it('reports a tied native score without naming a tournament winner or offering casual rematch', async () => {
    const tied: ArenaMatchState = {
        ...completed,
        results: [
            { sessionId: 'alice', username: 'Alice', scoreDelta: 100, killsDelta: 2, deathsDelta: 0, rank: 1 },
            { sessionId: 'bob', username: 'Bob', scoreDelta: 100, killsDelta: 0, deathsDelta: 1, rank: 2 }
        ]
    };
    arena = { ...arena, tournament: { ...arena.tournament, mode: 'tournament' } };
    let returned = false;
    await act(async () =>
        root.render(createElement(MatchWinnerOverlay, {
            match: tied,
            arena,
            onReturnToBracket: () => {
                returned = true;
            }
        }))
    );
    expect(container.querySelector('h2')?.textContent).toBe('Tied score — replay required');
    expect(container.textContent).not.toContain('survives the metrics');
    expect([...container.querySelectorAll('button')].some((control) => control.textContent === 'Play again')).toBe(false);
    await act(async () => button('Return to tournament bracket').click());
    expect(returned).toBe(true);
});

function button(label: string): HTMLButtonElement {
    const result = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    if (!result) {
        throw new Error(`Missing visible control: ${label}`);
    }
    return result;
}
