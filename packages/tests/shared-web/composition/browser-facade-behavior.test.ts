import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { describe, expect, it, vi } from 'vitest';

describe('browser facade behavior', () => {
    it('configures defaults and honors explicitly disabled setup startup work', async () => {
        const facade = createRallarFacade();

        const result = await facade.setup({
            apiBaseUrl: 'https://api.example.test///',
            applicationId: 'arena',
            workspaceId: 'match',
            start: {
                restoreSession: false,
                connect: false,
                refreshRooms: false,
                refreshPeople: false
            }
        });

        expect(readApiBaseUrl()).toBe('https://api.example.test');
        expect(facade.defaults()).toEqual({
            applicationId: 'arena',
            workspaceId: 'match'
        });
        expect(result).toEqual({
            session: undefined,
            connected: false
        });
    });

    it('starts disconnected and owns idempotent subscription cleanup', () => {
        const facade = createRallarFacade();
        const first = vi.fn();
        const second = vi.fn();
        const late = vi.fn();
        const subscriptions = facade.subscriptions();

        subscriptions.add(first);
        subscriptions.add(undefined);
        subscriptions.add(second);
        subscriptions.unsubscribe();
        subscriptions.unsubscribe();
        subscriptions.add(late);

        expect(facade.status()).toBe('idle');
        expect(facade.isConnected()).toBe(false);
        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
        expect(late).toHaveBeenCalledOnce();
        expect(subscriptions.size()).toBe(0);
    });
});
