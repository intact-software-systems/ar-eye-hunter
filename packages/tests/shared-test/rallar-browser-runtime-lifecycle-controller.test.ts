import { describe, expect, it, vi } from 'vitest';
import { createBlackBoxRallarLifecycleController } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/lifecycle-controller.ts';

type Config = Readonly<{
    key: string;
    logoutOnClose?: boolean;
}>;

function createController() {
    return createBlackBoxRallarLifecycleController<Config, string, string, string>({
        authenticationKey: (config) => config.key,
        mergeAuthenticationConfig: (active, next) => ({
            ...next,
            logoutOnClose: active.logoutOnClose || next.logoutOnClose
        }),
        authenticationClosedError: () => new Error('authentication closed'),
        connectionClosedError: () => new Error('connection closed')
    });
}

describe('browser Rallar lifecycle controller', () => {
    it('deduplicates matching authentication work and preserves cleanup policy', async () => {
        const controller = createController();
        let resolveAuthentication!: (session: string) => void;
        const effect = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    resolveAuthentication = resolve;
                })
        );

        const first = controller.runAuthentication({ key: 'alice' }, effect);
        const second = controller.runAuthentication(
            {
                key: 'alice',
                logoutOnClose: true
            },
            effect
        );

        expect(effect).toHaveBeenCalledTimes(1);
        expect(controller.authenticationConfig()).toEqual({
            key: 'alice',
            logoutOnClose: true
        });
        resolveAuthentication('session-1');
        await expect(Promise.all([first, second])).resolves.toEqual(['session-1', 'session-1']);
    });

    it('deduplicates matching connect work', async () => {
        const controller = createController();
        let resolveConnect!: (value: string) => void;
        const effect = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    resolveConnect = resolve;
                })
        );

        const first = controller.runConnect('target-a', effect);
        const second = controller.runConnect('target-a', effect);

        expect(effect).toHaveBeenCalledTimes(1);
        resolveConnect('connected');
        await expect(Promise.all([first, second])).resolves.toEqual(['connected', 'connected']);
    });

    it('serializes external authentication behind active connection work', async () => {
        const controller = createController();
        let resolveConnect!: (value: string) => void;
        const connecting = controller.runConnect(
            'target-a',
            () =>
                new Promise<string>((resolve) => {
                    resolveConnect = resolve;
                })
        );
        const authenticationEffect = vi.fn(async () => 'session-b');

        const authenticating = controller.runAuthentication(
            { key: 'bob' },
            authenticationEffect
        );
        expect(authenticationEffect).not.toHaveBeenCalled();

        resolveConnect('connected');
        await expect(connecting).resolves.toBe('connected');
        await expect(authenticating).resolves.toBe('session-b');
        expect(authenticationEffect).toHaveBeenCalledTimes(1);
    });

    it('aborts and waits for lifecycle work before single-flight close cleanup', async () => {
        const controller = createController();
        let resolveAuthentication!: (session: string) => void;
        let signal: AbortSignal | undefined;
        const authentication = controller.runAuthentication({ key: 'alice', logoutOnClose: true }, (controllerSignal) => {
            signal = controllerSignal;
            return new Promise((resolve) => {
                resolveAuthentication = resolve;
            });
        });
        const authenticationResult = expect(authentication).rejects.toThrow('authentication closed');
        const cleanup = vi.fn(async (context) => context.authenticationConfig?.logoutOnClose ? 'logged-out' : 'disconnected');

        const firstClose = controller.close(cleanup);
        const secondClose = controller.close(cleanup);
        expect(signal?.aborted).toBe(true);
        expect(cleanup).not.toHaveBeenCalled();

        resolveAuthentication('session-1');
        await authenticationResult;
        await expect(Promise.all([firstClose, secondClose])).resolves.toEqual(['logged-out', 'logged-out']);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('aborts the current operation generation before waiting for close dependencies', async () => {
        const controller = createController();
        const activeSignal = controller.operationSignal();
        let releasePending!: () => void;
        const pending = new Promise<void>((resolve) => {
            releasePending = resolve;
        });
        const cleanup = vi.fn(async () => 'closed');

        const closing = controller.close(cleanup, [pending]);

        expect(activeSignal.aborted).toBe(true);
        expect(controller.operationSignal()).not.toBe(activeSignal);
        expect(controller.operationSignal().aborted).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();

        releasePending();
        await expect(closing).resolves.toBe('closed');
    });

    it('fences connect completion after close starts', async () => {
        const controller = createController();
        let resolveConnect!: (value: string) => void;
        const connecting = controller.runConnect('target-a', async (context) => {
            const value = await new Promise<string>((resolve) => {
                resolveConnect = resolve;
            });
            context.assertCurrent();
            return value;
        });
        const connectionResult = expect(connecting).rejects.toThrow('connection closed');
        const closing = controller.close(async () => 'closed');

        resolveConnect('connected');
        await connectionResult;
        await expect(closing).resolves.toBe('closed');
    });
});
