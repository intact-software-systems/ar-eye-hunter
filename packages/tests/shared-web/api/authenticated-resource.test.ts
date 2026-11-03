import { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface View {
    readonly name: string;
}
interface Request {
    name: string;
}
const alice: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'alice-session', accessToken: 'test', expiresAtEpochMs: 9999999999999 };
const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
});

function browser() {
    let session: AuthSession | undefined = alice;
    const auth = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const api = {
        read: vi.fn<AuthenticatedResource.Api<View, Request>['read']>(async ({ session }) => ({ name: session.clientId })),
        change: vi.fn<AuthenticatedResource.Api<View, Request>['change']>(async () => null)
    };
    const owner = new AuthenticatedResource(
        {
            auth: { session: () => session, onChange: (listener) => auth.subscribe(listener).unsubscribe },
            activity: { isActive: () => true, onChange: () => () => {} },
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        },
        { scope: { applicationId: 'game', workspaceId: 'default' }, refreshIntervalMs: 30000 },
        api
    );
    cleanups.push(() => owner.stop());
    return {
        owner,
        api,
        login(next: AuthSession | undefined) {
            session = next;
            auth.publishLatest({ authenticated: next !== undefined, reason: next ? 'login' : 'logout', session: next });
        }
    };
}

describe('authenticated resource command lifetime', () => {
    it('retains immutable command identity after an uncertain write and fences an older read', async () => {
        const test = browser();
        await test.owner.start();
        const late = Promise.withResolvers<View>();
        test.api.read.mockReturnValueOnce(late.promise);
        const read = test.owner.refresh();
        test.api.change.mockRejectedValueOnce(new Error('Lost response'));
        const request = { name: 'original' };
        await test.owner.act(request);
        request.name = 'mutated';
        late.resolve({ name: 'stale' });
        await read;
        expect(test.owner.getState()).toMatchObject({ view: { name: 'alice' }, retryPending: true });
        await test.owner.act({ name: 'replacement' });
        expect(test.api.change).toHaveBeenCalledTimes(1);
        await test.owner.retry();
        expect(test.api.change.mock.calls[1]?.[0]).toEqual(test.api.change.mock.calls[0]?.[0]);
        expect(test.api.change.mock.calls[1]?.[0].request).toEqual({ name: 'original' });
        expect(test.owner.getState()).toMatchObject({ busy: false, retryPending: false, error: null });
    });

    it('does not let a late write clear a replacement account command or expose its result', async () => {
        const test = browser();
        await test.owner.start();
        const late = Promise.withResolvers<string | null>();
        test.api.change.mockReturnValueOnce(late.promise);
        const write = test.owner.act({ name: 'alice-command' });
        test.login({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
        await test.owner.refresh();
        test.api.change.mockRejectedValueOnce(new Error('Bob response lost'));
        await test.owner.act({ name: 'bob-command' });
        late.resolve('Alice refusal');
        await write;
        expect(test.owner.getState()).toMatchObject({ view: { name: 'bob' }, error: 'Bob response lost', retryPending: true });
        await test.owner.retry();
        expect(test.api.change.mock.calls[2]?.[0]).toEqual(test.api.change.mock.calls[1]?.[0]);
        test.login(undefined);
        expect(test.owner.getState()).toEqual({ view: null, busy: false, retryPending: false, error: null });
    });

    it('discards an in-flight read after stop and restarts with fresh account state', async () => {
        const test = browser();
        const late = Promise.withResolvers<View>();
        test.api.read.mockReturnValueOnce(late.promise);
        const start = test.owner.start();
        test.owner.stop();
        await test.owner.start();
        late.resolve({ name: 'stopped' });
        await start;
        expect(test.owner.getState().view).toEqual({ name: 'alice' });
    });
});

it.each([401, 403])('clears private state and pending work immediately when an action loses authority (%s)', async (status) => {
    const test = browser();
    await test.owner.start();
    test.api.change.mockRejectedValueOnce(new ApiHttpError('POST', '/private-command', status, 'Refused'));
    await test.owner.act({ name: 'change' });
    expect(test.owner.getState()).toMatchObject({ view: null, busy: false, retryPending: false });
    expect(test.owner.getState().error).toContain(String(status));
});

it('discards an uncertain command when a subsequent read discovers revoked authority', async () => {
    const test = browser();
    await test.owner.start();
    test.api.change.mockRejectedValueOnce(new Error('Response lost'));
    await test.owner.act({ name: 'change' });
    expect(test.owner.getState().retryPending).toBe(true);
    test.api.read.mockRejectedValueOnce(new ApiHttpError('GET', '/private-evidence', 403, 'Refused'));
    await test.owner.refresh();
    expect(test.owner.getState()).toMatchObject({ view: null, busy: false, retryPending: false });
    expect(test.owner.getState().error).toContain('403');
});
