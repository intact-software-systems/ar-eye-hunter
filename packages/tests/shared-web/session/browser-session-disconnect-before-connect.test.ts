import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, it, vi } from 'vitest';

// The browser state caches are configured during connect, so everything here
// runs with the repositories genuinely unconfigured. Mocking them -- as the
// auth-session contract fixture does -- is what hid this defect.
const session: AuthSession = {
    clientId: 'client-1',
    accessToken: 'access-token-1',
    username: 'alice',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000
};

const mocks = vi.hoisted(() => ({
    clearSession: vi.fn(),
    readSession: vi.fn(),
    logoutFromApi: vi.fn(() => Promise.resolve({ loggedOut: true }))
}));

vi.mock(import('@shared/api/auth.ts'), async (importOriginal) => ({
    ...(await importOriginal()),
    clearSession: mocks.clearSession,
    readSession: mocks.readSession
}));

vi.mock(import('@shared-web/browser/auth/session-http-api.ts'), async (importOriginal) => ({
    ...(await importOriginal()),
    logoutFromApi: mocks.logoutFromApi
}));

describe('Rallar session teardown before a first connect', () => {
    it('resolves disconnect on a page that never connected', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');

        await expect(createRallarFacade().disconnect()).resolves.toBeUndefined();
    });

    it('subscribes to rooms and people before connect', async () => {
        // Subscribing on mount and connecting later is the ordinary app shape,
        // and the initial delivery is a notification like any other emit.
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();

        expect(() => facade.rooms.onChange(() => undefined)).not.toThrow();
        expect(() => facade.people.onChange(() => undefined)).not.toThrow();
    });

    it('notifies auth listeners when logging out before connect', async () => {
        // The app's sign-out rests on this notification: when it is skipped the
        // UI stays signed in.
        mocks.readSession.mockReturnValue(session);
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const states: RallarAuthState[] = [];
        facade.auth.onChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        await facade.auth.logout();

        expect(states.at(-1)).toMatchObject({ authenticated: false, reason: 'logout' });
    });
});
