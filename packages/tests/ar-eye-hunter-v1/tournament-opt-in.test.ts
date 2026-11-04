// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { ArenaTournamentClient } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/arena-tournament-client.ts';
import { ArenaTournamentsEnabled } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/arena-tournaments-enabled.ts';
import { useArenaTournament } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/use-arena-tournament.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([false, true])('requires room classification only when tournaments are enabled (%s)', async (enabled) => {
    const start = vi.spyOn(ArenaTournamentClient.prototype, 'start').mockResolvedValue();
    const container = document.createElement('div');
    const root = createRoot(container);
    function Room() {
        const tournament = useArenaTournament('casual-room', {
            clientId: 'alice',
            username: 'alice',
            sessionId: 'session-alice',
            accessToken: 'local-test-token',
            expiresAtEpochMs: 9999999999999
        });
        return createElement('output', null, tournament.mode);
    }
    try {
        await act(async () =>
            root.render(
                enabled
                    ? createElement(ArenaTournamentsEnabled, { value: true }, createElement(Room))
                    : createElement(Room)
            )
        );
        expect(container.textContent).toBe(enabled ? 'loading' : 'casual');
        if (!enabled) {
            expect(start).not.toHaveBeenCalled();
        }
    }
    finally {
        await act(async () => root.unmount());
        vi.restoreAllMocks();
    }
});
