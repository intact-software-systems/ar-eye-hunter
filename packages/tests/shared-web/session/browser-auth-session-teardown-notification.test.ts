import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { BrowserSessionAuthLifecycle } from '@shared-web/browser/session/session-auth-lifecycle.ts';
import { describe, expect, it, vi } from 'vitest';

type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    clearSession: vi.fn(),
    readSession: vi.fn()
}));

vi.mock(import('@shared/api/auth.ts'), async (importOriginal): Promise<Partial<AuthModule>> => ({
    ...await importOriginal(),
    clearSession: mocks.clearSession,
    readSession: mocks.readSession
}));

function createAuthLifecycle(
    emitState: () => void
): BrowserSessionAuthLifecycle {
    const transportRuntime = new BrowserTransportRuntime();
    const runtime = new BrowserFacadeRuntimeState(transportRuntime);
    return new BrowserSessionAuthLifecycle({
        connectionRuntime: runtime,
        transportRuntime,
        authRuntime: runtime,
        connectionLifecycle: {
            connect: () => Promise.reject(new Error('connect is not part of this contract')),
            disconnect: () => Promise.resolve()
        },
        emitState,
        closeDataScopes: () => Promise.resolve()
    });
}

describe('Rallar auth session teardown notification', () => {
    it('notifies auth listeners even when the state emit fails', async () => {
        // The app's sign-out rests on this notification, so a failing side
        // effect must not stand between the teardown and its listeners.
        const lifecycle = createAuthLifecycle(() => {
            throw new Error('state emit failed');
        });
        const states: RallarAuthState[] = [];
        lifecycle.onAuthChange((state) => {
            states.push(state);
        }, { emitCurrent: false });

        await expect(
            lifecycle.endAuthSession('logout', { revoke: false })
        ).rejects.toThrow('state emit failed');

        expect(states.at(-1)).toMatchObject({ authenticated: false, reason: 'logout' });
    });
});
