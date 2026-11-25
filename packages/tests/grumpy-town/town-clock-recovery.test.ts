// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { RallarWsLifecycleListener } from '@shared-web/browser/rallar.ts';
import { watchTownClockLoss } from '../../../apps/grumpy-town/src/online/watch-town-clock-loss.ts';

afterEach(() => vi.restoreAllMocks());

it.each(['background', 'offline'])('waits for the %s game to be reachable before starting a fresh clock', async condition => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(condition === 'background');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(condition !== 'offline');
    let listener: RallarWsLifecycleListener | undefined;
    const restore = vi.fn(async () => {});
    const lifetime = new AbortController();
    watchTownClockLoss({ ws: { onLifecycle: callback => { listener = callback; return () => {}; } } }, lifetime.signal, restore, vi.fn());
    const status = {
        connectState: 'idle', readyState: 'closed', isOpen: false, reconnecting: false, reconnectEnabled: false,
        reconnectAttempts: 0, maxReconnectAttempts: 0, reconnectExhausted: false
    } as const;
    await listener!({ kind: 'disconnected', atEpochMs: 100, status, reason: 'server-clock-ended: suspended' });
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    online.mockReturnValue(true);
    if (condition === 'background') document.dispatchEvent(new Event('visibilitychange'));
    else window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    lifetime.abort();
});
