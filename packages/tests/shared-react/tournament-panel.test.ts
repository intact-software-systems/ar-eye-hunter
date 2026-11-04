// @vitest-environment happy-dom
import { TournamentPanel } from '@shared-react/tournament-panel.tsx';
import { RallarTournamentCatalog } from '@shared-web/browser/tournaments/rallar-tournament-catalog.ts';
import { RallarTournament } from '@shared-web/browser/tournaments/rallar-tournament.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { createTournament } from '@shared/tournaments/compute-tournament.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

it('opens a linked bracket without registering or leaving a room, then registers only on a click', async () => {
    const scope = { applicationId: 'game', workspaceId: 'default' };
    const ref = { ...scope, tournamentId: 'cup' };
    const session = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
    const change = vi.fn<RallarTournament.Api['change']>(async ({ requestId }) => ({ ref, requestId, status: 'applied', code: null }));
    const enter = vi.fn();
    const owner = new RallarTournament({
        auth: { session: () => session, onChange: () => () => {} },
        activity: { isActive: () => true, onChange: () => () => {} },
        createId: () => crypto.randomUUID(),
        timers: createDefaultTimers(),
        entry: { enter, getState: () => ({ status: 'idle', destination: null, principalId: null, failure: null }) },
        api: {
            change,
            read: async () => ({
                ref,
                principalId: 'alice',
                observedAtEpochMs: 1000,
                listing: 'unlisted',
                tournament: createTournament({
                    ref,
                    title: 'Friday cup',
                    organizerPrincipalId: 'bob',
                    rulesId: 'native-v1',
                    createdAtEpochMs: 1,
                    noShowGraceMs: 600000
                })
            })
        }
    }, { scope, tournamentId: 'cup', refreshIntervalMs: 10000 });
    const catalog = new RallarTournamentCatalog({
        onChanged: () => () => {},
        auth: { session: () => session, onChange: () => () => {} },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers: createDefaultTimers(),
        api: { read: async ({ view }) => ({ scope, principalId: 'alice', view, observedAtEpochMs: 1000, entries: [], nextCursor: null }) }
    }, { scope, limit: 20, timeoutMs: 10000 });
    window.location.hash = '#rallar-tournament?applicationId=game&workspaceId=default&tournamentId=cup';
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(createElement(TournamentPanel, { scope, catalog, createOwner: () => owner })));
        expect(container.textContent).toContain('Friday cup');
        expect(change).not.toHaveBeenCalled();
        expect(enter).not.toHaveBeenCalled();
        const register = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Register for tournament');
        expect(register).toBeDefined();
        await act(async () => register!.click());
        expect(change.mock.calls[0][0].request).toEqual({ type: 'register' });
        expect(enter).not.toHaveBeenCalled();
    }
    finally {
        await act(async () => root.unmount());
        container.remove();
        window.location.hash = '';
    }
});
