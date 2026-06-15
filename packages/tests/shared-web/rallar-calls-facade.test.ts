import { describe, expect, it, vi } from 'vitest';
import { createRallarCallsFacade } from '@shared-web/browser/rallar-calls-facade.ts';
import type {
    RallarCallHandle,
    RallarCallInviteListener,
    RallarCallInviteResult,
    RallarCallSignalListener,
} from '@shared-web/browser/rallar.ts';

describe('Rallar calls facade factory', () => {
    it('delegates call methods through injected operations', async () => {
        const handle = { id: 'call-1' } as RallarCallHandle;
        const inviteResult = {
            callId: 'call-1',
            peerIds: ['peer-1'],
            signals: [],
        } satisfies RallarCallInviteResult;
        const unsubscribe = vi.fn();
        const inviteListener = vi.fn() as RallarCallInviteListener;
        const signalListener = vi.fn() as RallarCallSignalListener;
        const operations = {
            start: vi.fn(async () => handle),
            invite: vi.fn(async () => inviteResult),
            onInvite: vi.fn(() => unsubscribe),
            onSignal: vi.fn(() => unsubscribe),
        };

        const facade = createRallarCallsFacade(operations);

        await expect(facade.start({
            peerId: 'peer-1',
            callId: 'call-1',
        })).resolves.toBe(handle);
        await expect(facade.invite({
            peerId: 'peer-1',
            callId: 'call-1',
            message: 'join',
        })).resolves.toBe(inviteResult);
        expect(facade.onInvite(inviteListener)).toBe(unsubscribe);
        expect(facade.onSignal(signalListener)).toBe(unsubscribe);

        expect(operations.start).toHaveBeenCalledWith({
            peerId: 'peer-1',
            callId: 'call-1',
        });
        expect(operations.invite).toHaveBeenCalledWith({
            peerId: 'peer-1',
            callId: 'call-1',
            message: 'join',
        });
        expect(operations.onInvite).toHaveBeenCalledWith(inviteListener);
        expect(operations.onSignal).toHaveBeenCalledWith(signalListener);
    });
});
