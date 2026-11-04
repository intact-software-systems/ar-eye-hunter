// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
    expect,
    it,
    vi
} from 'vitest';

import { rallar } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { ArenaTournamentsEnabled } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/arena-tournaments-enabled.ts';
import { useArenaTournament } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/use-arena-tournament.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([false, true])('requires room classification only when tournaments are enabled (%s)', async (enabled) => {
    const session: AuthSession = {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'session-alice',
        accessToken: 'local-test-token',
        expiresAtEpochMs: 9999999999999
    };
    const requestedPaths = new Set<string>();
    vi.useFakeTimers();
    vi.spyOn(rallar, 'session').mockReturnValue(session);
    vi.stubGlobal('fetch', async (url: string) => {
        requestedPaths.add(new URL(url, 'http://api.test').pathname);
        return new Response('Tournament routes unavailable', { status: 404 });
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    function Room() {
        const tournament = useArenaTournament('casual-room', session);
        return createElement('output', { 'data-error': tournament.error }, tournament.mode);
    }
    try {
        await act(async () =>
            root.render(
                enabled
                    ? createElement(ArenaTournamentsEnabled, { value: true }, createElement(Room))
                    : createElement(Room)
            )
        );
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(container.textContent).toBe(enabled ? 'loading' : 'casual');
        expect([...requestedPaths]).toEqual(enabled ? ['/api/ar-eye/rooms/casual-room/tournament'] : []);
        if (enabled) {
            expect(container.querySelector('output')?.getAttribute('data-error')).toContain('404');
        }
    }
    finally {
        await act(async () => root.unmount());
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    }
});
