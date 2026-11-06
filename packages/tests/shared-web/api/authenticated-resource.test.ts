import { AuthenticatedResource } from '@shared-web/browser/api/authenticated-resource.ts';
import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

interface View {
    readonly name: string;
}
interface Request {
    name: string;
}
interface ResourceBrowser {
    readonly owner: AuthenticatedResource<View, Request>;
    readonly api: {
        readonly read: Mock<AuthenticatedResource.Api<View, Request>['read']>;
        readonly change: Mock<AuthenticatedResource.Api<View, Request>['change']>;
    };
    login(next: AuthSession | undefined): void;
    invalidate(): void;
}
const alice: AuthSession = {
    clientId: 'alice',
    username: 'alice',
    sessionId: 'alice-session',
    accessToken: 'test',
    expiresAtEpochMs: 9999999999999
};
const cleanups: (() => void)[] = [];
afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
});

function browser(): ResourceBrowser {
    let session: AuthSession | undefined = alice;
    const auth = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    const changes = new SynchronousNotifications<void>((error) => {
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
        {
            scope: { applicationId: 'game', workspaceId: 'default' },
            changeResult: 'read',
            subscribeRefresh: (listener) => changes.subscribe(listener).unsubscribe
        },
        api
    );
    cleanups.push(() => owner.stop());
    return {
        owner,
        api,
        invalidate: () => changes.publishLatest(undefined),
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
        const started = Promise.withResolvers<void>();
        test.api.read.mockImplementationOnce(() => {
            started.resolve();
            return late.promise;
        });
        const read = test.owner.refresh();
        await started.promise;
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
        const started = Promise.withResolvers<void>();
        test.api.read.mockImplementationOnce(() => {
            started.resolve();
            return late.promise;
        });
        const start = test.owner.start();
        await started.promise;
        const queued = test.owner.refresh();
        test.owner.stop();
        await test.owner.start();
        late.resolve({ name: 'stopped' });
        await Promise.all([start, queued]);
        expect(test.owner.getState().view).toEqual({ name: 'alice' });
        // Stopping cancels the pending old-generation read rather than sending it.
        expect(test.api.read).toHaveBeenCalledTimes(2);
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

describe('authenticated resource refresh coverage', () => {
    it('covers changes arriving during a read with one trailing read for the burst', async () => {
        const test = browser();
        await test.owner.start();
        const started = Promise.withResolvers<void>();
        const older = Promise.withResolvers<View>();
        test.api.read.mockImplementationOnce(() => {
            started.resolve();
            return older.promise;
        });
        const first = test.owner.refresh();
        await started.promise;
        test.api.read.mockResolvedValue({ name: 'updated-party' });
        const burst = [test.owner.refresh(), test.owner.refresh(), test.owner.refresh()];
        older.resolve({ name: 'older-party' });
        await Promise.all([first, ...burst]);
        expect(test.owner.getState().view).toEqual({ name: 'updated-party' });
        // Network coalescing is the contract: initial, held read, one trailing read.
        expect(test.api.read).toHaveBeenCalledTimes(3);
    });

    it('recovers a failed older read when a later change requests fresh state', async () => {
        const test = browser();
        await test.owner.start();
        const started = Promise.withResolvers<void>();
        const older = Promise.withResolvers<View>();
        test.api.read.mockImplementationOnce(() => {
            started.resolve();
            return older.promise;
        });
        const first = test.owner.refresh();
        await started.promise;
        test.api.read.mockResolvedValue({ name: 'recovered-party' });
        const changed = test.owner.refresh();
        older.reject(new Error('Read disconnected'));
        await Promise.all([first, changed]);
        expect(test.owner.getState()).toMatchObject({ view: { name: 'recovered-party' }, error: null });
    });
});

it('starts replacement-account reads without waiting for old account refreshes', async () => {
    const test = browser();
    await test.owner.start();
    const started = Promise.withResolvers<void>();
    const older = Promise.withResolvers<View>();
    test.api.read.mockImplementationOnce(() => {
        started.resolve();
        return older.promise;
    });
    const first = test.owner.refresh();
    await started.promise;
    const queued = test.owner.refresh();
    test.login({ ...alice, clientId: 'bob', sessionId: 'bob-session' });
    await test.owner.refresh();
    expect(test.owner.getState().view).toEqual({ name: 'bob' });
    older.resolve({ name: 'private-alice' });
    await Promise.all([first, queued]);
    expect(test.owner.getState().view).toEqual({ name: 'bob' });
    // Queued work must never issue another request using the replaced credentials.
    expect(test.api.read.mock.calls.filter(([request]) => request.session.clientId === 'alice')).toHaveLength(2);
});

it('subscribes before reading, covers a push during that read, and detaches on stop', async () => {
    const test = browser();
    const started = Promise.withResolvers<void>();
    const older = Promise.withResolvers<View>();
    test.api.read.mockImplementationOnce(() => {
        started.resolve();
        return older.promise;
    });
    const start = test.owner.start();
    await started.promise;
    test.api.read.mockResolvedValue({ name: 'pushed' });
    test.invalidate();
    test.invalidate();
    older.resolve({ name: 'before-push' });
    await start;
    await vi.waitFor(() => expect(test.owner.getState().view).toEqual({ name: 'pushed' }));
    expect(test.api.read).toHaveBeenCalledTimes(2);
    test.owner.stop();
    test.invalidate();
    await Promise.resolve();
    expect(test.api.read).toHaveBeenCalledTimes(2);
});

describe('authenticated resource error lifetime', () => {
    it('keeps a command refusal through background reads until the user refreshes, and clears a failed read on success', async () => {
        const test = browser();
        await test.owner.start();
        test.api.change.mockResolvedValueOnce('This invitation is no longer available.');
        await test.owner.act({ name: 'join' });
        test.api.read.mockResolvedValueOnce({ name: 'after-push' });
        test.invalidate();
        await vi.waitFor(() => expect(test.owner.getState().view).toEqual({ name: 'after-push' }));
        expect(test.owner.getState().error).toBe('This invitation is no longer available.');
        await test.owner.refresh();
        expect(test.owner.getState().error).toBeNull();
        test.api.read.mockRejectedValueOnce(new Error('Read failed'));
        test.invalidate();
        await vi.waitFor(() => expect(test.owner.getState().error).toBe('Read failed'));
        test.invalidate();
        await vi.waitFor(() => expect(test.owner.getState()).toMatchObject({ view: { name: 'alice' }, error: null }));
    });
});
