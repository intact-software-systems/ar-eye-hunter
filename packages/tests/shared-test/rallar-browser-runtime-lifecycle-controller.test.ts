import { describe, expect, it } from 'vitest';
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
        const runs: string[] = [];
        let resolveAuthentication!: (session: string) => void;
        const effect = () => {
            runs.push('authentication');
            return new Promise<string>((resolve) => {
                resolveAuthentication = resolve;
            });
        };

        const first = controller.runAuthentication({ key: 'alice' }, effect);
        const second = controller.runAuthentication(
            {
                key: 'alice',
                logoutOnClose: true
            },
            effect
        );

        expect(runs).toEqual(['authentication']);
        expect(controller.authenticationConfig()).toEqual({
            key: 'alice',
            logoutOnClose: true
        });
        resolveAuthentication('session-1');
        await expect(Promise.all([first, second])).resolves.toEqual(['session-1', 'session-1']);
    });

    it('deduplicates matching connect work', async () => {
        const controller = createController();
        const runs: string[] = [];
        let resolveConnect!: (value: string) => void;
        const effect = () => {
            runs.push('connect');
            return new Promise<string>((resolve) => {
                resolveConnect = resolve;
            });
        };

        const first = controller.runConnect('target-a', effect);
        const second = controller.runConnect('target-a', effect);

        expect(runs).toEqual(['connect']);
        resolveConnect('connected');
        await expect(Promise.all([first, second])).resolves.toEqual(['connected', 'connected']);
    });

    it('serializes external authentication behind active connection work', async () => {
        const controller = createController();
        const runs: string[] = [];
        let resolveConnect!: (value: string) => void;
        const connecting = controller.runConnect(
            'target-a',
            () => {
                runs.push('connect');
                return new Promise<string>((resolve) => {
                    resolveConnect = resolve;
                });
            }
        );

        const authenticating = controller.runAuthentication(
            { key: 'bob' },
            async () => {
                runs.push('authentication');
                return 'session-b';
            }
        );
        expect(runs).toEqual(['connect']);

        resolveConnect('connected');
        await expect(connecting).resolves.toBe('connected');
        await expect(authenticating).resolves.toBe('session-b');
        expect(runs).toEqual(['connect', 'authentication']);
    });

    it('aborts and waits for lifecycle work before single-flight close cleanup', async () => {
        const controller = createController();
        const cleanupRuns: string[] = [];
        let resolveAuthentication!: (session: string) => void;
        let signal: AbortSignal | undefined;
        const authentication = controller.runAuthentication({ key: 'alice', logoutOnClose: true }, (controllerSignal) => {
            signal = controllerSignal;
            return new Promise((resolve) => {
                resolveAuthentication = resolve;
            });
        });
        const authenticationResult = expect(authentication).rejects.toThrow('authentication closed');
        const cleanup = async (context: { authenticationConfig?: Config; }) => {
            const outcome = context.authenticationConfig?.logoutOnClose ? 'logged-out' : 'disconnected';
            cleanupRuns.push(outcome);
            return outcome;
        };

        const firstClose = controller.close(cleanup);
        const secondClose = controller.close(cleanup);
        expect(signal?.aborted).toBe(true);
        expect(cleanupRuns).toEqual([]);

        resolveAuthentication('session-1');
        await authenticationResult;
        await expect(Promise.all([firstClose, secondClose])).resolves.toEqual(['logged-out', 'logged-out']);
        expect(cleanupRuns).toEqual(['logged-out']);
    });

    it('aborts the current operation generation before waiting for close dependencies', async () => {
        const controller = createController();
        const cleanupRuns: string[] = [];
        const activeSignal = controller.operationSignal();
        let releasePending!: () => void;
        const pending = new Promise<void>((resolve) => {
            releasePending = resolve;
        });
        const cleanup = async () => {
            cleanupRuns.push('closed');
            return 'closed';
        };

        const closing = controller.close(cleanup, [pending]);

        expect(activeSignal.aborted).toBe(true);
        expect(controller.operationSignal()).not.toBe(activeSignal);
        expect(controller.operationSignal().aborted).toBe(false);
        expect(cleanupRuns).toEqual([]);

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

    it('authenticates again after a close that failed', async () => {
        // A headless agent keeps one runtime for the life of its page, so a
        // close failure that closed nothing must not end its usefulness.
        const controller = createController();
        await expectFailedClose(controller);

        await expect(
            controller.runAuthentication({ key: 'alice' }, async () => 'session-1')
        ).resolves.toBe('session-1');
    });

    it('runs connect work again after a close that failed', async () => {
        const controller = createController();
        await expectFailedClose(controller);

        await expect(
            controller.runConnect('target-a', async () => 'connected')
        ).resolves.toBe('connected');
    });
});

async function expectFailedClose(controller: ReturnType<typeof createController>): Promise<void> {
    await expect(
        controller.close(async () => {
            throw new Error('cleanup failed');
        })
    ).rejects.toThrow('cleanup failed');
}
