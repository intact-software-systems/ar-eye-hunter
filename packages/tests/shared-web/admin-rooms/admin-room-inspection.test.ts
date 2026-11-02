import { afterEach, expect, it, vi } from 'vitest';

import { AdminRoomInspection } from '@shared-web/browser/admin-rooms/admin-room-inspection.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

const scope = { applicationId: 'ar-eye-hunter', workspaceId: 'default' };
const roomRef = { ...scope, groupId: 'room-1' };
const directory = { scope, observedAtEpochMs: 1_000, completeness: 'complete', entries: [], nextAfterGroupId: null };
const explanation = {
    target: { kind: 'group', groupRef: roomRef },
    generatedAtEpochMs: 1_000,
    facts: [],
    timeline: [],
    warnings: [],
    likelyCauses: [],
    suggestedActions: [],
    rawRefs: []
};
const admin: AuthSession = { clientId: 'admin', username: 'admin', sessionId: 'admin-session', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
const cleanups: (() => void)[] = [];

afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.unstubAllGlobals();
});

it('loads the bounded directory and selected explanation under the same API session', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(String(url).includes('/explain/') ? explanation : directory));
    vi.stubGlobal('fetch', fetch);
    const test = inspection();
    await test.owner.start();
    expect(test.owner.getState().view).toEqual({ directory, explanation });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, options] of fetch.mock.calls) {
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-only');
    }
});

it('clears all private evidence when either read refuses the operator, then recovers on a fresh refresh', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => Response.json(String(url).includes('/explain/') ? explanation : directory));
    vi.stubGlobal('fetch', fetch);
    const test = inspection();
    await test.owner.start();
    expect(test.owner.getState().view?.explanation).toEqual(explanation);
    fetch.mockImplementation(async (url) =>
        String(url).includes('/explain/')
            ? Response.json({ error: 'Forbidden' }, { status: 403 })
            : Response.json(directory)
    );
    await test.owner.refresh();
    expect(test.owner.getState().view).toBeNull();
    expect(test.owner.getState().error).toContain('403');
    fetch.mockImplementation(async (url) => Response.json(String(url).includes('/explain/') ? explanation : directory));
    await test.owner.refresh();
    expect(test.owner.getState()).toMatchObject({ view: { directory, explanation }, error: null });
});

it('aborts and discards late account evidence after logout and late selection evidence after stop', async () => {
    const late = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => late.promise);
    vi.stubGlobal('fetch', fetch);
    const test = inspection(null);
    const start = test.owner.start();
    test.login(undefined);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    late.resolve(Response.json(directory));
    await start;
    expect(test.owner.getState().view).toBeNull();

    fetch.mockImplementation(async () => Response.json(directory));
    test.login(admin);
    await test.owner.refresh();
    expect(test.owner.getState().view?.directory).toEqual(directory);
    const obsolete = Promise.withResolvers<Response>();
    fetch.mockImplementation(() => obsolete.promise);
    const refresh = test.owner.refresh();
    test.owner.stop();
    expect(fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    obsolete.resolve(Response.json(directory));
    await refresh;
    expect(test.owner.getState().view).toBeNull();
});

function inspection(selectedGroupId: string | null = roomRef.groupId) {
    let session: AuthSession | undefined = admin;
    const changes = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const owner = new AdminRoomInspection({
        auth: { session: () => session, onChange: (listener) => changes.subscribe(listener).unsubscribe },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers: createDefaultTimers(),
        createId: () => crypto.randomUUID()
    }, { scope, apiBaseUrl: 'https://api.example.test', afterGroupId: null, selectedGroupId, refreshIntervalMs: 30_000 });
    cleanups.push(() => owner.stop());
    return {
        owner,
        login(next: AuthSession | undefined) {
            session = next;
            changes.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
        }
    };
}
